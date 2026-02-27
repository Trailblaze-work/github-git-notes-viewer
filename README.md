# GitHub Git Notes Viewer

A browser extension that displays [git notes](https://git-scm.com/docs/git-notes) inline on GitHub commit pages.

Git notes are a powerful but underused Git feature -- they let you attach metadata to commits without modifying them. However, GitHub's web UI doesn't display git notes at all. This extension fills that gap: when you view a commit on GitHub, it fetches and displays any associated git notes right on the page, with automatic format detection and rich rendering.

## Screenshots

**Rendered markdown note** -- a [claude-prompt-trail](https://github.com/Trailblaze-work/claude-prompt-trail) note displayed with full markdown rendering, format badge, and raw/rendered toggle:

![Git notes displayed on a GitHub commit page](screenshots/notes-displayed.png)

**Multiple note refs** -- two different refs shown together, each with its own detected format (Markdown and JSON):

![Multiple git note refs displayed](screenshots/multiple-refs.png)

## Features

- **Zero config for public repos** -- uses your GitHub session for note discovery, fetches content from `raw.githubusercontent.com`. Works out of the box.
- **Private repo support** -- requires a GitHub fine-grained PAT with **Contents: Read-only** permission, scoped to the repos you need. GitHub doesn't expose raw note content for private repos through any cookie-authenticated endpoint.
- **Auto-discovery** -- automatically discovers all note refs in a repo via the GitHub API, plus tries common defaults (`refs/notes/commits`, `refs/notes/claude-prompt-trail`). No need to configure which refs to check.
- **Auto format detection** -- detects Markdown, JSON, and YAML content and renders it appropriately
- **Rich rendering** -- Markdown notes are rendered with full GFM support (tables, code blocks, lists, etc.) via [marked](https://github.com/markedjs/marked)
- **Format badge** -- shows the detected format (MARKDOWN, JSON, YAML) in the note header
- **Raw/rendered toggle** -- click the `</>` button to switch between rendered and raw views
- **Multiple refs** -- check several note refs at once (e.g. `refs/notes/commits` + `refs/notes/claude-prompts`)
- **Collapse/expand** -- long notes start collapsed with a "Show full note" button
- **XSS protection** -- all rendered HTML is sanitized with [DOMPurify](https://github.com/cure53/DOMPurify) using a strict tag/attribute allowlist

## Install

1. Clone this repository
2. **Chrome/Edge**: Go to `chrome://extensions`, enable "Developer mode", click "Load unpacked", select this directory
3. **Firefox**: Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", select `manifest.json`

The extension works immediately for **public repos** -- no token needed.

For **private repos**, open the extension options and add a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to the repos you need with **Contents: Read-only** permission.

## How It Works

The extension runs as a content script on GitHub commit pages. It uses same-origin `fetch` requests with your existing GitHub session cookies to retrieve note content:

1. `GET /{owner}/{repo}/tree/{noteRef}` (JSON) -- list entries in the notes tree
2. `GET /{owner}/{repo}/raw/{noteRef}/{commitSha}` -- fetch the raw note content

For private repos, `raw.githubusercontent.com` requires authentication. The extension uses a stored PAT (if configured) to fetch note content.

The notes tree response is used to match the current commit SHA (handling abbreviated SHAs and fanout directory layouts used by large repos). Content is fetched directly as raw text.

### Format detection and rendering

Once a note's content is fetched, the extension detects its format:

| Format | Detection | Rendering |
|---|---|---|
| Markdown | Headers, bold, lists, tables, code blocks, HTML comments | Full GFM via marked + DOMPurify sanitization |
| JSON | Starts with `{` or `[` and parses successfully | Pretty-printed with 2-space indent |
| YAML | Multiple `key: value` lines | Syntax-highlighted keys |
| Plain text | Fallback | Monospace `<pre>` block |

## Security

All rendered HTML (from Markdown) is sanitized by **DOMPurify** with a strict allowlist of tags and attributes. Scripts, event handlers, forms, iframes, and other XSS vectors are stripped before content is injected into the page.

## Configuration

Open the extension options page to configure:

- **GitHub PAT** -- required for private repos. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Contents: Read-only** permission. Not needed for public repos.
- **Additional note refs** -- extra refs to check beyond the auto-discovered ones and defaults (`refs/notes/commits`, `refs/notes/claude-prompt-trail`)
- **Clear cache** -- flush the in-memory notes tree cache

## Development

```
npm install
npm test              # Run E2E tests
npm run screenshots   # Regenerate README screenshots
```

### Project structure

```
├── manifest.json       MV3 manifest (Chrome + Firefox)
├── background.js       Service worker: GitHub API (PAT fallback), caching
├── content.js          Content script: cookie-based fetch, format detection, rendering
├── content.css         Styles matching GitHub's design language
├── lib/                marked.min.js + purify.min.js (vendored)
├── popup.html/js/css   Toolbar popup: auth status, settings link
├── options.html/js/css Options page: PAT, note refs, cache
├── icons/              Extension icons
├── test/               E2E tests and screenshot generator
└── screenshots/        Generated screenshots for README
```

## Cross-browser support

- **Chrome / Edge**: Manifest V3 service worker
- **Firefox**: Manifest V3 background scripts (dual declaration in manifest)
- Uses `browser.storage.local` for persistence (works everywhere)

## License

MIT

---

<p align="center">
  <a href="https://trailblaze.work">
    <img src="https://raw.githubusercontent.com/Trailblaze-work/trailblaze.work/main/trailblaze-mark.svg" alt="Trailblaze" width="50" />
  </a>
</p>
<h3 align="center">Built by <a href="https://trailblaze.work">Trailblaze</a></h3>
<p align="center">
  We help companies deploy AI across their workforce.<br>
  Strategy, implementation, training, and governance.<br><br>
  <a href="mailto:hello@trailblaze.work"><strong>hello@trailblaze.work</strong></a>
</p>
