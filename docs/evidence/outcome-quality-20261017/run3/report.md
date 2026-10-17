# Outcome Quality - automated evaluation

TECHNICAL = the file is valid and (when measured) opens in the real application. QUALITY = automated checks of structure, accuracy, layout, accessibility and editability. Neither says the prose or the design is good: that is human review.

| File | Measured by | TECHNICAL | QUALITY | Checks (pass / fail / not run) |
|---|---|---|---|---|
| DECK-1 (DECK-1.pptx) | Microsoft PowerPoint 16.0 | PASS | PARTIAL | 19 / 0 / 1 |
| DECK-2 (DECK-2.pptx) | Microsoft PowerPoint 16.0 | PASS | PARTIAL | 20 / 0 / 1 |
| DOC-1 (DOC-1.docx) | Microsoft Word 16.0 | PASS | PASS | 19 / 0 / 0 |
| DOC-2 (DOC-2.docx) | Microsoft Word 16.0 | PASS | PASS | 19 / 0 / 0 |
| DOC-3 (DOC-3.docx) | Microsoft Word 16.0 | PASS | PASS | 20 / 0 / 0 |

## DECK-1

| Check | Kind | Status | Detail |
|---|---|---|---|
| PACKAGE_VALID | TECHNICAL | PASS | zip, XML, content types and relationships are consistent |
| SIXTEEN_BY_NINE | QUALITY | PASS | slide size 12192000 x 6858000 EMU |
| EVERY_SLIDE_HAS_A_TITLE_PLACEHOLDER | QUALITY | PASS | 7 slide(s), each titled (outline view and screen readers work) |
| BAR_CHARTS_START_AT_ZERO | QUALITY | PASS | 1 bar chart(s), 0 without an explicit zero baseline |
| CHARTS_ARE_NATIVE_WITH_DATA | QUALITY | PASS | 1 chart(s), 1 embedded workbook(s) |
| CHARTS_PRESENT | QUALITY | PASS | 1 native chart(s) in the file, 1 expected |
| PICTURES_HAVE_ALT_TEXT | QUALITY | PASS | 0 picture(s), 0 without alt text |
| SPEAKER_NOTES_PRESENT | QUALITY | PASS | 7 note(s) for 6 content slide(s) (at least 80%) |
| SLIDES_ARE_NOT_WALLS_OF_TEXT | QUALITY | PASS | no slide over 90 words |
| NO_PLACEHOLDER_TEXT | QUALITY | PASS | no placeholder or "withheld" text |
| REQUIRED_FACTS_PRESENT | QUALITY | PASS | 2 of 2 present |
| NO_INVENTED_FIGURES | QUALITY | PASS | every stated figure is in what the person gave |
| SLIDE_COUNT_IN_RANGE | QUALITY | PASS | 7 slide(s), expected 7-8 |
| OPENS_IN_POWERPOINT | TECHNICAL | PASS | Microsoft PowerPoint 16.0 |
| NO_TEXT_OVERFLOW | QUALITY | PASS | no text taller than its box (BoundHeight read back from PowerPoint) |
| EVERYTHING_INSIDE_THE_SLIDE | QUALITY | PASS | every shape within the 16:9 slide |
| READABLE_FONT_SIZES | QUALITY | PASS | no text under 12 pt (page numbers and the brand mark aside) |
| FONTS_CONSISTENT | QUALITY | PASS | 1 font family(ies): Malgun Gothic |
| CHART_DATA_AS_EXPECTED | QUALITY | NOT_RUN | no chart data was expected |
| EDIT_AND_SAVE_SURVIVES | QUALITY | PASS | opened, the first text edited, saved as a copy, reopened, the edit read back |

## DECK-2

| Check | Kind | Status | Detail |
|---|---|---|---|
| PACKAGE_VALID | TECHNICAL | PASS | zip, XML, content types and relationships are consistent |
| SIXTEEN_BY_NINE | QUALITY | PASS | slide size 12192000 x 6858000 EMU |
| EVERY_SLIDE_HAS_A_TITLE_PLACEHOLDER | QUALITY | PASS | 6 slide(s), each titled (outline view and screen readers work) |
| BAR_CHARTS_START_AT_ZERO | QUALITY | PASS | 1 bar chart(s), 0 without an explicit zero baseline |
| CHARTS_ARE_NATIVE_WITH_DATA | QUALITY | PASS | 1 chart(s), 1 embedded workbook(s) |
| PICTURES_PRESENT | QUALITY | PASS | 1 picture(s) in the file, 1 expected |
| CHARTS_PRESENT | QUALITY | PASS | 1 native chart(s) in the file, 1 expected |
| PICTURES_HAVE_ALT_TEXT | QUALITY | PASS | 1 picture(s), 0 without alt text |
| SPEAKER_NOTES_PRESENT | QUALITY | PASS | 5 note(s) for 5 content slide(s) (at least 80%) |
| SLIDES_ARE_NOT_WALLS_OF_TEXT | QUALITY | PASS | no slide over 90 words |
| NO_PLACEHOLDER_TEXT | QUALITY | PASS | no placeholder or "withheld" text |
| REQUIRED_FACTS_PRESENT | QUALITY | PASS | 3 of 3 present |
| NO_INVENTED_FIGURES | QUALITY | PASS | every stated figure is in what the person gave |
| SLIDE_COUNT_IN_RANGE | QUALITY | PASS | 6 slide(s), expected 6-7 |
| OPENS_IN_POWERPOINT | TECHNICAL | PASS | Microsoft PowerPoint 16.0 |
| NO_TEXT_OVERFLOW | QUALITY | PASS | no text taller than its box (BoundHeight read back from PowerPoint) |
| EVERYTHING_INSIDE_THE_SLIDE | QUALITY | PASS | every shape within the 16:9 slide |
| READABLE_FONT_SIZES | QUALITY | PASS | no text under 12 pt (page numbers and the brand mark aside) |
| FONTS_CONSISTENT | QUALITY | PASS | 1 font family(ies): Calibri |
| CHART_DATA_AS_EXPECTED | QUALITY | NOT_RUN | no chart data was expected |
| EDIT_AND_SAVE_SURVIVES | QUALITY | PASS | opened, the first text edited, saved as a copy, reopened, the edit read back |

## DOC-1

| Check | Kind | Status | Detail |
|---|---|---|---|
| PACKAGE_VALID | TECHNICAL | PASS | zip, XML, content types and relationships are consistent |
| HAS_TITLE | QUALITY | PASS | a Title paragraph |
| HEADINGS_ARE_REAL_AND_ORDERED | QUALITY | PASS | 5 real heading(s), no skipped level |
| TABLES_HAVE_HEADER_ROWS | QUALITY | PASS | 1 table(s), 1 header row(s) |
| PICTURES_HAVE_ALT_TEXT | QUALITY | PASS | 0 picture(s), 0 with alt text |
| NO_MISSING_PICTURES | QUALITY | PASS | every referenced picture is in the file |
| FOOTER_PAGE_NUMBERS | QUALITY | PASS | page / pages field in the footer |
| MODERN_COMPATIBILITY_SETTING | QUALITY | PASS | compatibility mode 15 declared |
| NO_PLACEHOLDER_TEXT | QUALITY | PASS | no placeholder or "withheld" text |
| REQUIRED_FACTS_PRESENT | QUALITY | PASS | 9 of 9 present |
| NO_INVENTED_FIGURES | QUALITY | PASS | every stated figure is in what the person gave |
| OPENS_IN_WORD | TECHNICAL | PASS | Microsoft Word 16.0 |
| NOT_COMPATIBILITY_MODE | QUALITY | PASS | compatibility mode 15 |
| PAGE_COUNT_IN_RANGE | QUALITY | PASS | 1 page(s), expected 1-6 |
| TABLES_FIT_THE_PAGE | QUALITY | PASS | 1 table(s), 0 wider than the text |
| PICTURES_FIT_THE_PAGE | QUALITY | PASS | 0 picture(s), 0 wider than the text |
| FOOTER_FIELDS_LIVE | QUALITY | PASS | 2 field(s) in the footer |
| FONTS_CONSISTENT | QUALITY | PASS | 1 font family(ies): 맑은 고딕 |
| EDIT_AND_SAVE_SURVIVES | QUALITY | PASS | opened for editing, a paragraph added, saved, reopened, the edit read back |

## DOC-2

| Check | Kind | Status | Detail |
|---|---|---|---|
| PACKAGE_VALID | TECHNICAL | PASS | zip, XML, content types and relationships are consistent |
| HAS_TITLE | QUALITY | PASS | a Title paragraph |
| HEADINGS_ARE_REAL_AND_ORDERED | QUALITY | PASS | 4 real heading(s), no skipped level |
| TABLES_HAVE_HEADER_ROWS | QUALITY | PASS | 1 table(s), 1 header row(s) |
| PICTURES_HAVE_ALT_TEXT | QUALITY | PASS | 0 picture(s), 0 with alt text |
| NO_MISSING_PICTURES | QUALITY | PASS | every referenced picture is in the file |
| FOOTER_PAGE_NUMBERS | QUALITY | PASS | page / pages field in the footer |
| MODERN_COMPATIBILITY_SETTING | QUALITY | PASS | compatibility mode 15 declared |
| NO_PLACEHOLDER_TEXT | QUALITY | PASS | no placeholder or "withheld" text |
| REQUIRED_FACTS_PRESENT | QUALITY | PASS | 4 of 4 present |
| NO_INVENTED_FIGURES | QUALITY | PASS | every stated figure is in what the person gave |
| OPENS_IN_WORD | TECHNICAL | PASS | Microsoft Word 16.0 |
| NOT_COMPATIBILITY_MODE | QUALITY | PASS | compatibility mode 15 |
| PAGE_COUNT_IN_RANGE | QUALITY | PASS | 1 page(s), expected 1-4 |
| TABLES_FIT_THE_PAGE | QUALITY | PASS | 1 table(s), 0 wider than the text |
| PICTURES_FIT_THE_PAGE | QUALITY | PASS | 0 picture(s), 0 wider than the text |
| FOOTER_FIELDS_LIVE | QUALITY | PASS | 2 field(s) in the footer |
| FONTS_CONSISTENT | QUALITY | PASS | 1 font family(ies): Calibri |
| EDIT_AND_SAVE_SURVIVES | QUALITY | PASS | opened for editing, a paragraph added, saved, reopened, the edit read back |

## DOC-3

| Check | Kind | Status | Detail |
|---|---|---|---|
| PACKAGE_VALID | TECHNICAL | PASS | zip, XML, content types and relationships are consistent |
| HAS_TITLE | QUALITY | PASS | a Title paragraph |
| HEADINGS_ARE_REAL_AND_ORDERED | QUALITY | PASS | 4 real heading(s), no skipped level |
| TABLES_HAVE_HEADER_ROWS | QUALITY | PASS | 1 table(s), 1 header row(s) |
| PICTURES_HAVE_ALT_TEXT | QUALITY | PASS | 1 picture(s), 1 with alt text |
| PICTURES_PRESENT | QUALITY | PASS | 1 picture(s) in the file, 1 expected |
| NO_MISSING_PICTURES | QUALITY | PASS | every referenced picture is in the file |
| FOOTER_PAGE_NUMBERS | QUALITY | PASS | page / pages field in the footer |
| MODERN_COMPATIBILITY_SETTING | QUALITY | PASS | compatibility mode 15 declared |
| NO_PLACEHOLDER_TEXT | QUALITY | PASS | no placeholder or "withheld" text |
| REQUIRED_FACTS_PRESENT | QUALITY | PASS | 9 of 9 present |
| NO_INVENTED_FIGURES | QUALITY | PASS | every stated figure is in what the person gave |
| OPENS_IN_WORD | TECHNICAL | PASS | Microsoft Word 16.0 |
| NOT_COMPATIBILITY_MODE | QUALITY | PASS | compatibility mode 15 |
| PAGE_COUNT_IN_RANGE | QUALITY | PASS | 2 page(s), expected 1-4 |
| TABLES_FIT_THE_PAGE | QUALITY | PASS | 1 table(s), 0 wider than the text |
| PICTURES_FIT_THE_PAGE | QUALITY | PASS | 1 picture(s), 0 wider than the text |
| FOOTER_FIELDS_LIVE | QUALITY | PASS | 2 field(s) in the footer |
| FONTS_CONSISTENT | QUALITY | PASS | 1 font family(ies): 맑은 고딕 |
| EDIT_AND_SAVE_SURVIVES | QUALITY | PASS | opened for editing, a paragraph added, saved, reopened, the edit read back |
