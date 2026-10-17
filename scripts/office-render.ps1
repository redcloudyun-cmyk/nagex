# Opens a .docx / .pptx in the REAL Microsoft Office application on this PC (COM), reads layout FACTS from it, exports page / slide pictures, and proves the file can be edited and re-saved.
# Windows + Microsoft Office only. A LOCAL certification tool: never part of a gate or of CI.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/office-render.ps1 -Path <file.docx|file.pptx> -OutDir <dir>
#
# Writes into OutDir: facts.json (everything measured), text.txt (the text Office sees), page-N.png / slide-N.png (what Office draws). The file is opened READ-ONLY and never modified; the edit
# round trip works on a copy in OutDir. An Office instance that was already running (the person's own) is never quit and its other documents are never touched.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$ExportPdf   # opt-in: Word's PDF export blocked indefinitely on one run (hidden instance), so it is not part of the default measurement
)
$ErrorActionPreference = 'Stop'
$Path = (Resolve-Path -LiteralPath $Path).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
$facts = [ordered]@{ file = [IO.Path]::GetFileName($Path); bytes = (Get-Item -LiteralPath $Path).Length; extension = $ext; renderedBy = $null; opened = $false; problems = @() }

function Release($o) { if ($null -ne $o) { try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch {} } }

function Render-Word {
  $pre = [bool](Get-Process -Name WINWORD -ErrorAction SilentlyContinue)
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $null; $copy = $null
  try {
    $facts.renderedBy = "Microsoft Word $($word.Version)"
    $doc = $word.Documents.Open($Path, $false, $true, $false)   # ConfirmConversions=false, ReadOnly=true, AddToRecentFiles=false
    $facts.opened = $true
    # Word lays pages out lazily: finish the layout before anything is measured or drawn (an unfinished layout showed '1 / 2' on a 3-page document)
    $doc.Repaginate()
    $null = $doc.ComputeStatistics(2)
    $ps = $doc.PageSetup
    $textWidth = [math]::Round($ps.PageWidth - $ps.LeftMargin - $ps.RightMargin, 1)
    $facts.compatibilityMode = $doc.CompatibilityMode
    $facts.pages = $doc.ComputeStatistics(2)
    $facts.words = $doc.ComputeStatistics(0)
    $facts.paragraphs = $doc.Paragraphs.Count
    $facts.page = [ordered]@{ widthPt = $ps.PageWidth; heightPt = $ps.PageHeight; orientation = $ps.Orientation; leftMarginPt = $ps.LeftMargin; rightMarginPt = $ps.RightMargin; topMarginPt = $ps.TopMargin; bottomMarginPt = $ps.BottomMargin; textWidthPt = $textWidth }
    $facts.sections = $doc.Sections.Count
    # headers / footers of the first section
    $sec = $doc.Sections.Item(1)
    $facts.header = [ordered]@{ text = $sec.Headers.Item(1).Range.Text.Trim(); exists = $sec.Headers.Item(1).Exists }
    $facts.footer = [ordered]@{ text = $sec.Footers.Item(1).Range.Text.Trim(); exists = $sec.Footers.Item(1).Exists; pageNumberFields = $sec.Footers.Item(1).Range.Fields.Count }
    # headings (outline) and the styles in use
    $styles = @{}; $outline = New-Object System.Collections.Generic.List[object]
    $i = 0
    foreach ($p in $doc.Paragraphs) {
      $i += 1
      $name = [string]$p.Style.NameLocal
      if ($styles.ContainsKey($name)) { $styles[$name] += 1 } else { $styles[$name] = 1 }
      $lvl = [int]$p.OutlineLevel
      if ($lvl -ge 1 -and $lvl -le 9) { $outline.Add([ordered]@{ level = $lvl; text = $p.Range.Text.Trim(); page = $p.Range.Information(3) }) }
    }
    $facts.styles = $styles
    $facts.outline = $outline
    # tables: do they fit the text width, do they repeat their header row
    $tables = New-Object System.Collections.Generic.List[object]
    foreach ($t in $doc.Tables) {
      $w = 0.0; foreach ($c in $t.Rows.Item(1).Cells) { $w += $c.Width }
      $tables.Add([ordered]@{ rows = $t.Rows.Count; columns = $t.Columns.Count; widthPt = [math]::Round($w, 1); fitsTextWidth = ($w -le $textWidth + 1); headingRowRepeats = [bool]$t.Rows.Item(1).HeadingFormat; startsOnPage = $t.Range.Information(3); firstRowText = ($t.Rows.Item(1).Range.Text -replace "[\r\a]+", ' | ').Trim() })
    }
    $facts.tables = $tables
    # pictures: size against the text width, alternative text
    $pics = New-Object System.Collections.Generic.List[object]
    foreach ($s in $doc.InlineShapes) {
      $pics.Add([ordered]@{ widthPt = [math]::Round($s.Width, 1); heightPt = [math]::Round($s.Height, 1); fitsTextWidth = ($s.Width -le $textWidth + 1); altText = [string]$s.AlternativeText; type = [int]$s.Type; page = $s.Range.Information(3) })
    }
    $facts.inlineShapes = $pics
    $facts.floatingShapes = $doc.Shapes.Count
    $facts.hyperlinks = $doc.Hyperlinks.Count
    $facts.fields = $doc.Fields.Count
    $facts.footnotes = $doc.Footnotes.Count
    # fonts: the distinct fonts the paragraphs use
    $fonts = @{}
    foreach ($p in $doc.Paragraphs) { $n = [string]$p.Range.Font.Name; if ($n) { $fonts[$n] = 1 + [int]$fonts[$n] } }
    $facts.fonts = $fonts
    [IO.File]::WriteAllText((Join-Path $OutDir 'text.txt'), $doc.Content.Text, [Text.UTF8Encoding]::new($false))
    # what Word draws: one picture per page, from the page's enhanced metafile
    $pageFiles = New-Object System.Collections.Generic.List[string]
    try {
      $window = $doc.ActiveWindow; $window.View.Type = 3
      $doc.Repaginate(); $null = $doc.Fields.Update(); $doc.Repaginate()
      Add-Type -AssemblyName System.Drawing
      $pages = $window.ActivePane.Pages
      for ($n = 1; $n -le [math]::Min($pages.Count, 30); $n += 1) {
        $bits = $pages.Item($n).EnhMetaFileBits
        $ms = New-Object IO.MemoryStream (, [byte[]]$bits)
        $meta = New-Object System.Drawing.Imaging.Metafile $ms
        $scale = 1.6
        $bmp = New-Object System.Drawing.Bitmap ([int]($ps.PageWidth * $scale)), ([int]($ps.PageHeight * $scale))
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.Clear([System.Drawing.Color]::White); $g.InterpolationMode = 'HighQualityBicubic'
        $g.DrawImage($meta, 0, 0, $bmp.Width, $bmp.Height)
        $file = Join-Path $OutDir "page-$n.png"; $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $pageFiles.Add([IO.Path]::GetFileName($file))
        $g.Dispose(); $bmp.Dispose(); $meta.Dispose(); $ms.Dispose()
      }
    } catch { $facts.problems += "PAGE_PICTURES_FAILED: $($_.Exception.Message)" }
    $facts.pagePictures = $pageFiles
    # PDF export (opt-in)
    if ($ExportPdf) { try { $pdf = Join-Path $OutDir 'document.pdf'; $doc.ExportAsFixedFormat($pdf, 17); $facts.pdfBytes = (Get-Item -LiteralPath $pdf).Length } catch { $facts.problems += "PDF_EXPORT_FAILED: $($_.Exception.Message)" } }
    # editability: close the read-only original, edit a plain COPY of the file the way a person would (open for editing, add a paragraph, save), reopen it and read it back
    try {
      $doc.Close($false); Release $doc; $doc = $null
      $copyPath = Join-Path $OutDir 'edited-copy.docx'
      Copy-Item -LiteralPath $Path -Destination $copyPath -Force
      $edit = $word.Documents.Open($copyPath, $false, $false, $false)
      $edit.Content.InsertParagraphAfter(); $edit.Content.InsertAfter('NAgex edit round trip')
      $edit.Save(); $edit.Close($false); Release $edit
      $copy = $word.Documents.Open($copyPath, $false, $true, $false)
      $facts.editRoundTrip = [ordered]@{ saved = $true; reopened = $true; editSurvived = $copy.Content.Text.Contains('NAgex edit round trip'); pagesAfterEdit = $copy.ComputeStatistics(2) }
    } catch { $facts.editRoundTrip = [ordered]@{ saved = $false; error = $_.Exception.Message } }
  } finally {
    if ($copy) { try { $copy.Close($false) } catch {}; Release $copy }
    if ($doc) { try { $doc.Close($false) } catch {}; Release $doc }
    if (-not $pre) { try { $word.Quit($false) } catch {} }
    Release $word
  }
}

function Render-PowerPoint {
  $pre = [bool](Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)
  $app = New-Object -ComObject PowerPoint.Application
  $pres = $null; $copy = $null
  try {
    $facts.renderedBy = "Microsoft PowerPoint $($app.Version)"
    $pres = $app.Presentations.Open($Path, -1, 0, 0)   # ReadOnly, untitled=false, WithWindow=false
    $facts.opened = $true
    $sw = $pres.PageSetup.SlideWidth; $sh = $pres.PageSetup.SlideHeight
    $facts.slideSize = [ordered]@{ widthPt = $sw; heightPt = $sh; ratio = [math]::Round($sw / $sh, 4) }
    $facts.slideCount = $pres.Slides.Count
    $facts.masterLayouts = $pres.SlideMaster.CustomLayouts.Count
    $facts.themeFonts = [ordered]@{ major = $pres.SlideMaster.Theme.ThemeFontScheme.MajorFont.Item(1).Name; minor = $pres.SlideMaster.Theme.ThemeFontScheme.MinorFont.Item(1).Name }
    $slides = New-Object System.Collections.Generic.List[object]
    $allText = New-Object System.Text.StringBuilder
    foreach ($slide in $pres.Slides) {
      $shapes = New-Object System.Collections.Generic.List[object]
      foreach ($s in $slide.Shapes) {
        $e = [ordered]@{ name = $s.Name; type = [int]$s.Type; leftPt = [math]::Round($s.Left, 1); topPt = [math]::Round($s.Top, 1); widthPt = [math]::Round($s.Width, 1); heightPt = [math]::Round($s.Height, 1)
          insideSlide = (($s.Left -ge -1) -and ($s.Top -ge -1) -and (($s.Left + $s.Width) -le ($sw + 1)) -and (($s.Top + $s.Height) -le ($sh + 1))); hasText = $false; hasChart = $false; isPicture = $false }
        if ($s.Type -eq 13) { $e.isPicture = $true; $e.altText = [string]$s.AlternativeText }
        try { if ($s.HasChart -eq -1) { $e.hasChart = $true } } catch {}
        if ($e.hasChart) {
          $c = $s.Chart; $series = New-Object System.Collections.Generic.List[object]
          for ($k = 1; $k -le $c.SeriesCollection().Count; $k += 1) { $ser = $c.SeriesCollection($k); $series.Add([ordered]@{ name = [string]$ser.Name; values = @($ser.Values | ForEach-Object { [double]$_ }); categories = @($ser.XValues | ForEach-Object { [string]$_ }) }) }
          $e.chart = [ordered]@{ chartType = [int]$c.ChartType; hasTitle = [bool]$c.HasTitle; title = $(if ($c.HasTitle) { [string]$c.ChartTitle.Text } else { '' }); hasLegend = [bool]$c.HasLegend; series = $series }
        }
        try {
          if ($s.HasTextFrame -eq -1 -and $s.TextFrame.HasText -eq -1) {
            $r = $s.TextFrame.TextRange
            $e.hasText = $true; $e.text = $r.Text.Trim()
            $e.fontNames = @($r.Runs() | ForEach-Object { $_.Font.Name } | Select-Object -Unique)
            $sizes = @($r.Runs() | ForEach-Object { [double]$_.Font.Size }); $e.minFontPt = ($sizes | Measure-Object -Minimum).Minimum; $e.maxFontPt = ($sizes | Measure-Object -Maximum).Maximum
            $e.textHeightPt = [math]::Round($r.BoundHeight, 1); $e.textWidthPt = [math]::Round($r.BoundWidth, 1)
            # the text overflows its shape when it is taller than the shape (a small tolerance for rounding)
            $e.textOverflows = ($r.BoundHeight -gt ($s.Height + 2))
            [void]$allText.AppendLine($r.Text)
          }
        } catch {}
        if ($s.Type -eq 19) {   # table
          $t = $s.Table; $cells = New-Object System.Collections.Generic.List[string]
          foreach ($row in $t.Rows) { foreach ($cell in $row.Cells) { $cells.Add(($cell.Shape.TextFrame.TextRange.Text)) } }
          $e.table = [ordered]@{ rows = $t.Rows.Count; columns = $t.Columns.Count; cells = $cells }
          [void]$allText.AppendLine(($cells -join ' | '))
        }
        $shapes.Add($e)
      }
      $title = ''; try { if ($slide.Shapes.HasTitle -eq -1) { $title = $slide.Shapes.Title.TextFrame.TextRange.Text } } catch {}
      $notes = ''; try { $notes = $slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text } catch {}
      $slides.Add([ordered]@{ index = $slide.SlideIndex; layout = [string]$slide.CustomLayout.Name; title = $title; notes = $notes; shapes = $shapes })
      $png = Join-Path $OutDir "slide-$($slide.SlideIndex).png"
      $slide.Export($png, 'PNG', 1600, 900)
    }
    $facts.slides = $slides
    [IO.File]::WriteAllText((Join-Path $OutDir 'text.txt'), $allText.ToString(), [Text.UTF8Encoding]::new($false))
    # editability: change the first slide's title, save a COPY, reopen it and read it back
    try {
      $copyPath = Join-Path $OutDir 'edited-copy.pptx'
      $first = $pres.Slides.Item(1)
      $target = $null; foreach ($s in $first.Shapes) { if ($s.HasTextFrame -eq -1 -and $s.TextFrame.HasText -eq -1) { $target = $s; break } }
      if ($target) { $target.TextFrame.TextRange.InsertAfter(' (edited)') | Out-Null }
      $pres.SaveCopyAs($copyPath)
      $copy = $app.Presentations.Open($copyPath, -1, 0, 0)
      $back = ''; foreach ($s in $copy.Slides.Item(1).Shapes) { if ($s.HasTextFrame -eq -1 -and $s.TextFrame.HasText -eq -1) { $back = $s.TextFrame.TextRange.Text; break } }
      $facts.editRoundTrip = [ordered]@{ saved = $true; reopened = $true; editSurvived = $back.Contains('(edited)'); slidesAfterEdit = $copy.Slides.Count }
    } catch { $facts.editRoundTrip = [ordered]@{ saved = $false; error = $_.Exception.Message } }
  } finally {
    if ($copy) { try { $copy.Close() } catch {}; Release $copy }
    if ($pres) { try { $pres.Close() } catch {}; Release $pres }
    if (-not $pre) { try { $app.Quit() } catch {} }
    Release $app
  }
}

try {
  switch ($ext) {
    '.docx' { Render-Word }
    '.pptx' { Render-PowerPoint }
    default { throw "Unsupported file type: $ext" }
  }
} catch {
  $facts.problems += "RENDER_FAILED: $($_.Exception.Message)"
}
$facts | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $OutDir 'facts.json') -Encoding UTF8
Write-Output ("opened={0} renderedBy={1} problems={2}" -f $facts.opened, $facts.renderedBy, $facts.problems.Count)
