param([string]$File, [string]$OutDir, [string]$Tag)
# Opens a .pptx in the real Microsoft PowerPoint (COM), exports every slide to PNG and measures text fit per shape.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$ppt = New-Object -ComObject PowerPoint.Application
$result = [ordered]@{ file = (Split-Path $File -Leaf); opened = $false; slides = @() }
try {
  $pres = $ppt.Presentations.Open($File, -1, 0, 0)   # ReadOnly, Untitled=false, WithWindow=false
  $result.opened = $true
  $result.slideWidthPt = $pres.PageSetup.SlideWidth
  $result.slideHeightPt = $pres.PageSetup.SlideHeight
  $i = 0
  foreach ($s in $pres.Slides) {
    $i++
    $png = Join-Path $OutDir ("{0}_slide{1:00}.png" -f $Tag, $i)
    $s.Export($png, 'PNG', 1600, 900)
    $shapes = @()
    foreach ($sh in $s.Shapes) {
      $o = [ordered]@{ name = $sh.Name; type = [int]$sh.Type; placeholder = ($sh.Type -eq 14); left = [math]::Round($sh.Left); top = [math]::Round($sh.Top); width = [math]::Round($sh.Width); height = [math]::Round($sh.Height) }
      if ($sh.HasTextFrame -and $sh.TextFrame2.HasText) {
        $tr = $sh.TextFrame2.TextRange
        $o.textChars = $tr.Text.Length
        $o.fontName = $tr.Font.Name
        $o.fontNameFarEast = $tr.Font.NameFarEast
        $o.fontSizePt = [math]::Round($tr.Font.Size, 1)
        $o.boundHeight = [math]::Round($tr.BoundHeight)
        $o.boundBottom = [math]::Round($tr.BoundTop + $tr.BoundHeight)
        $o.overflowPt = [math]::Round([math]::Max(0, ($tr.BoundTop + $tr.BoundHeight) - ($sh.Top + $sh.Height)))
        $o.beyondSlidePt = [math]::Round([math]::Max(0, ($tr.BoundTop + $tr.BoundHeight) - $pres.PageSetup.SlideHeight))
      }
      $shapes += $o
    }
    $notes = ''
    try { $notes = $s.NotesPage.Shapes.Placeholders(2).TextFrame.TextRange.Text } catch { }
    $result.slides += [ordered]@{ index = $i; layout = $s.CustomLayout.Name; shapeCount = $s.Shapes.Count; notesChars = $notes.Length; shapes = $shapes }
  }
  $pres.Close()
} catch { $result.error = $_.Exception.Message } finally { $ppt.Quit() }
$result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $OutDir "$Tag.json")
"{0}: opened={1} slides={2}" -f $Tag, $result.opened, $result.slides.Count
