# Pixiv Batch Downloader (Original Quality)

A lightweight Tampermonkey / Violentmonkey userscript to batch download original-quality artworks, multi-page manga, and user galleries from Pixiv with zero-stall queue management, customizable naming templates, and chunked ZIP archiving.

## Features

* **Original Quality Downloads:** Directly grabs source-resolution master images from `i.pximg.net` bypassing Pixiv's hotlink restrictions via internal headers.
* **Dual Download Modes:**
  * `direct`: Triggers immediate browser downloads per file.
  * `zip`: Packages downloads into in-memory `.zip` archives with chunking support (`zipChunkSize`) to prevent browser memory exhaustion.
* **Multi-Page Manga Handling:** Configurable support to fetch all or a capped number of sub-pages per submission.
* **Smart Page Scanning:** Extracts artwork IDs directly from the DOM as well as fallback Pixiv internal Ajax endpoints (tag searches, user profile submissions).
* **Queue Controls:** Integrated floating overlay with live progress tracking, Pause / Resume, and Cancellation handling.
* **Custom Naming Tokens:** Template system supporting `{id}`, `{title}`, `{artist}`, `{artistId}`, `{page}`, `{pageCount}`, `{date}`, `{bookmarks}`, `{r18}`, and `{ai}`.
* **Metadata Filtering:** Built-in options to filter by minimum bookmark count, AI generation tags, and R-18 restrictions.

## Installation

1. Install a userscript manager extension:
   * Tampermonkey (Recommended)
   * Violentmonkey
2. Create a new script in your extension dashboard.
3. Paste the contents of `pixiv-downloader.user.js` into the editor and save.
4. Navigate to any Pixiv page (tag feed, user profile, or bookmark list).

## Configuration

Edit the `CONFIG` object near the top of the script to adjust default behavior:

```javascript
const CONFIG = {
  downloadMode: "direct",       // 'direct' or 'zip'
  zipChunkSize: 30,             // Number of artworks per ZIP file before splitting
  quality: "original",          // 'original', 'regular', 'small'
  fileNameTemplate: "{id}_{artist}_{title}_p{page}",
  includeMangaPages: true,      // Set to false to only grab cover / page 0
  maxMangaPages: 10,            // Max pages per multi-page set (set null/999 for all)
  downloadUgoira: false,        // Skip/include Ugoira animations
  minBookmarks: 0,              // Minimum bookmark threshold
  r18Filter: "all",             // 'all', 'safe_only', 'r18_only'
  aiFilter: "all",              // 'all', 'exclude_ai', 'ai_only'
  requestDelayMs: 400,          // Delay between API calls to prevent 429 rate limiting
  floatingPosition: "bottom-right", // 'bottom-right', 'bottom-left', 'top-right', 'top-left'
  notifyOnComplete: true
};
```

## Filename Template Tokens

| Token | Replacement Value | Example |
| :--- | :--- | :--- |
| `{id}` | Pixiv Artwork ID | `11223344` |
| `{title}` | Sanitized Artwork Title | `Summer_Sky` |
| `{artist}` | Sanitized Artist Username | `ArtistName` |
| `{artistId}` | Artist User ID | `123456` |
| `{page}` | 2-digit zero-padded page number | `01` |
| `{pageCount}` | Total page count in submission | `4` |
| `{date}` | Submission creation date (YYYY-MM-DD) | `2024-05-12` |
| `{bookmarks}` | Total bookmark count | `1520` |
| `{r18}` | Content rating tag | `safe` or `R-18` |
| `{ai}` | AI generation flag | `human` or `AI` |

## Dependencies

The script automatically pulls the following CDNs via `@require`:

* JSZip v3.10.1
* FileSaver.js v2.0.5

## Disclaimer

This script is for personal archival purposes only. Respect Pixiv's Terms of Service and content creators' rights. Do not redistribute artists' work without explicit permission.
