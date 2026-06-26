# SimpCity Post Downloader

A Tampermonkey userscript for downloading images and videos from SimpCity posts.

Based on the original [XenForo Post Downloader](https://github.com/SkyCloudDev/ForumPostDownloader/tree/main) by SkyCloudDev.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Click [here](https://github.com/courtneydax/sc-postdl/raw/main/scpostdl.user.js) to install the script
3. Confirm the installation in Tampermonkey

**Important**: Under the tampermonkey settings, set the Config mode to Advanced and enable the Browser API in Download Mode (BETA). Also, add m4v and mov to the list. It should look like this:

```/^[^\.]*$/
/\.(mp[34a]|m4[ab]|m3u|wma|wav|aac|og[ag]|cda|flac)$/
/\.(avi|mkv|flv|divx|mpe?g|webm|m4v|mov)$/
/\.(jpe?g|jpe|png|gif|bmp|tiff?|webp|hei[cf]|avif|jxl|svg|eps|ai|ico|dds|psd|xcf|raw|cr2|nef|arw)$/
/\.(srt|sub|idx)$/
/\.(ttf|otf|woff)$/
/\.(txt|pdf|json|yml|xml|csv)$/
.iso
/\.(zip|tgz|tar|bin)$/
/\.r(ar|[0-9]{2,2})$/
.rss
```

## Usage

Navigate to any SimpCity thread and use the download button added by the script.
