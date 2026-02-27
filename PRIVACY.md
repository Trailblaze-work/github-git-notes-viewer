# Privacy Policy — GitHub Git Notes Viewer

**Last updated:** February 27, 2026

## What this extension does

GitHub Git Notes Viewer displays git notes inline on GitHub commit pages. It fetches note content from GitHub's API and renders it on the page.

## Data collected

This extension stores the following data locally on your device using Chrome's `chrome.storage.local`:

- **GitHub Personal Access Token (PAT):** Optionally provided by the user to access notes on private repositories. This token is only sent to GitHub's API (`api.github.com` and `raw.githubusercontent.com`) and is never transmitted anywhere else.
- **Git notes ref configuration:** The user's preferred notes ref names (e.g., `refs/notes/commits`).

## Data not collected

This extension does **not**:

- Collect personally identifiable information
- Track browsing activity or page visits
- Use analytics, telemetry, or tracking of any kind
- Send data to any server other than GitHub's own API
- Store or process any data outside of your local browser

## Third-party services

The extension communicates only with GitHub (`api.github.com` and `raw.githubusercontent.com`) to fetch git notes content. No other third-party services are contacted.

## Data sharing

No user data is sold, transferred, or shared with any third party for any purpose.

## Changes to this policy

Updates to this privacy policy will be posted in this repository. The "last updated" date at the top will be revised accordingly.

## Contact

If you have questions about this privacy policy, please open an issue at https://github.com/Trailblaze-work/github-git-notes-viewer/issues.
