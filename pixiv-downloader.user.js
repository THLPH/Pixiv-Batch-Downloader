// ==UserScript==
// @name         Pixiv Batch Downloader (Original Quality)
// @namespace    https://github.com/pixiv-downloader
// @version      1.2.5
// @description  Batch download Pixiv artworks with zero-stall queue and direct mode switching.
// @author       Pixiv Downloader Extension
// @match        https://www.pixiv.net/*
// @icon         https://www.pixiv.net/favicon.ico
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      i.pximg.net
// @connect      pximg.net
// @connect      www.pixiv.net
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    downloadMode: "direct", // 'direct' or 'zip'
    zipChunkSize: 30,
    quality: "original",    // 'original', 'regular', 'small'
    fileNameTemplate: "{id}_{artist}_{title}_p{page}",
    includeMangaPages: true,
    maxMangaPages: 10,
    downloadUgoira: false,
    minBookmarks: 0,
    r18Filter: "all",
    aiFilter: "all",
    requestDelayMs: 400,
    floatingPosition: "bottom-right",
    notifyOnComplete: true
  };

  let isDownloading = false;
  let isPaused = false;
  let cancelRequested = false;
  let completedCount = 0;
  let totalCount = 0;

  function log(...args) {
    console.log('[PixivDownloader]', ...args);
  }

  function sanitizeName(name) {
    if (!name) return 'untitled';
    return name.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim().slice(0, 60);
  }

  function formatFilename(artwork, pageIndex = 0, totalPages = 1) {
    const tokens = {
      '{id}': artwork.id || '0',
      '{title}': sanitizeName(artwork.title || 'untitled'),
      '{artist}': sanitizeName(artwork.userName || 'unknown_artist'),
      '{artistId}': artwork.userId || '0',
      '{page}': (pageIndex + 1).toString().padStart(2, '0'),
      '{pageCount}': totalPages.toString(),
      '{date}': (artwork.createDate || '').split('T')[0] || new Date().toISOString().split('T')[0],
      '{bookmarks}': (artwork.bookmarkCount || 0).toString(),
      '{r18}': artwork.xRestrict > 0 ? 'R-18' : 'safe',
      '{ai}': artwork.aiType === 2 ? 'AI' : 'human'
    };

    let filename = CONFIG.fileNameTemplate;
    for (const [key, val] of Object.entries(tokens)) {
      filename = filename.replaceAll(key, val);
    }
    return sanitizeName(filename);
  }

  // Fetch with hard 15s timeout to eliminate infinite CDN hanging
  function fetchImageBuffer(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Request timed out after 15s'));
        }
      }, 15000);

      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 15000,
        headers: {
          'Referer': 'https://www.pixiv.net/',
          'Origin': 'https://www.pixiv.net',
          'User-Agent': navigator.userAgent
        },
        responseType: 'arraybuffer',
        onload: function (res) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (res.status >= 200 && res.status < 300) {
            resolve(res.response);
          } else {
            reject(new Error('HTTP status ' + res.status));
          }
        },
        onerror: function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
        ontimeout: function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error('GM_xmlhttpRequest timeout'));
        }
      });
    });
  }

  function downloadBufferDirectly(buffer, filename) {
    const blob = new Blob([buffer]);
    if (typeof saveAs === 'function') {
      saveAs(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  }

  async function fetchPixivAjax(endpoint) {
    const res = await fetch(endpoint, {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    if (!res.ok) throw new Error('API error: ' + res.status);
    const json = await res.json();
    if (json.error) throw new Error(json.message || 'Pixiv API returned error');
    return json.body;
  }

  async function getArtworkPages(illustId) {
    try {
      const illustData = await fetchPixivAjax('/ajax/illust/' + illustId);
      const pagesData = await fetchPixivAjax('/ajax/illust/' + illustId + '/pages');

      const pages = pagesData.map(p => {
        let selectedUrl = p.urls.original;
        if (CONFIG.quality === 'regular') selectedUrl = p.urls.regular;
        if (CONFIG.quality === 'small') selectedUrl = p.urls.small;
        return {
          targetUrl: selectedUrl,
          width: p.width,
          height: p.height
        };
      });

      return {
        id: illustId,
        title: illustData.title || 'illust_' + illustId,
        userName: illustData.userName || 'artist',
        userId: illustData.userId,
        bookmarkCount: illustData.bookmarkCount || 0,
        xRestrict: illustData.xRestrict || 0,
        aiType: illustData.aiType || 0,
        createDate: illustData.createDate,
        illustType: illustData.illustType,
        pages: pages
      };
    } catch (e) {
      log('Failed to fetch details for illust ' + illustId, e);
      return null;
    }
  }

  async function scanCurrentPageArtworkIds() {
    const ids = new Set();
    const links = document.querySelectorAll('a[href*="/artworks/"]');
    links.forEach(link => {
      const match = link.href.match(/\/artworks\/(\d+)/);
      if (match && match[1]) ids.add(match[1]);
    });

    const tagMatch = window.location.pathname.match(/\/tags\/([^/]+)/);
    if (tagMatch && tagMatch[1]) {
      const tag = decodeURIComponent(tagMatch[1]);
      try {
        const searchApiUrl = '/ajax/search/artworks/' + encodeURIComponent(tag) + '?word=' + encodeURIComponent(tag) + '&order=date_d&mode=all&p=1&s_mode=s_tag_full';
        const searchBody = await fetchPixivAjax(searchApiUrl);
        if (searchBody?.illustManga?.data) {
          searchBody.illustManga.data.forEach(item => {
            if (item.id) ids.add(item.id);
          });
        }
      } catch (err) {
        log('Search API fallback:', err);
      }
    }

    const userMatch = window.location.pathname.match(/\/users\/(\d+)/);
    if (userMatch && userMatch[1]) {
      const userId = userMatch[1];
      try {
        const userBody = await fetchPixivAjax('/ajax/user/' + userId + '/profile/all');
        if (userBody?.illusts) {
          Object.keys(userBody.illusts).forEach(id => ids.add(id));
        }
        if (userBody?.manga) {
          Object.keys(userBody.manga).forEach(id => ids.add(id));
        }
      } catch (err) {
        log('User profile API fallback:', err);
      }
    }

    return Array.from(ids);
  }

  async function runBatchDownload(illustIds) {
    if (isDownloading) return;
    isDownloading = true;
    isPaused = false;
    cancelRequested = false;
    completedCount = 0;
    totalCount = 0;

    updateUIState();
    log('Starting batch download for ' + illustIds.length + ' artworks');

    const validArtworks = [];
    showProgress(0, illustIds.length, 'Scanning metadata...');

    // 1. Scan Metadata
    for (let i = 0; i < illustIds.length; i++) {
      if (cancelRequested) {
        finishProcess('Cancelled metadata scan.');
        return;
      }
      while (isPaused) {
        await new Promise(r => setTimeout(r, 200));
        if (cancelRequested) {
          finishProcess('Cancelled metadata scan.');
          return;
        }
      }

      const id = illustIds[i];
      showProgress(i + 1, illustIds.length, 'Scanning #' + id + ' (' + (i + 1) + '/' + illustIds.length + ')');

      const data = await getArtworkPages(id);
      if (data) {
        if (data.bookmarkCount < CONFIG.minBookmarks) continue;
        if (CONFIG.r18Filter === 'safe_only' && data.xRestrict > 0) continue;
        if (CONFIG.r18Filter === 'r18_only' && data.xRestrict === 0) continue;
        if (CONFIG.aiFilter === 'exclude_ai' && data.aiType === 2) continue;
        if (CONFIG.aiFilter === 'ai_only' && data.aiType !== 2) continue;
        if (data.illustType === 2 && !CONFIG.downloadUgoira) continue;

        validArtworks.push(data);
      }

      await new Promise(r => setTimeout(r, CONFIG.requestDelayMs));
    }

    if (cancelRequested) {
      finishProcess('Download cancelled.');
      return;
    }

    // 2. Prepare task list
    const downloadTasks = [];
    for (const art of validArtworks) {
      const pageLimit = CONFIG.includeMangaPages ? Math.min(art.pages.length, CONFIG.maxMangaPages || 999) : 1;
      for (let p = 0; p < pageLimit; p++) {
        const page = art.pages[p];
        const filename = formatFilename(art, p, art.pages.length);
        const ext = page.targetUrl.split('.').pop().split('?')[0] || 'jpg';
        downloadTasks.push({
          url: page.targetUrl,
          filename: filename + '.' + ext
        });
      }
    }

    totalCount = downloadTasks.length;
    completedCount = 0;

    if (totalCount === 0) {
      finishProcess('No artworks matched filter.');
      return;
    }

    const baseTitle = sanitizeName(document.title.split(' - ')[0] || 'pixiv_batch');
    const timestamp = new Date().toISOString().slice(0, 10);
    const isZip = CONFIG.downloadMode === 'zip';
    const chunkSize = isZip ? (CONFIG.zipChunkSize || 30) : downloadTasks.length;
    const totalParts = Math.ceil(downloadTasks.length / chunkSize);

    // 3. Process Download Pipeline
    for (let part = 0; part < totalParts; part++) {
      if (cancelRequested) break;

      const chunkTasks = downloadTasks.slice(part * chunkSize, (part + 1) * chunkSize);
      let zipInstance = isZip ? new JSZip() : null;

      for (let i = 0; i < chunkTasks.length; i++) {
        if (cancelRequested) break;
        while (isPaused) {
          await new Promise(r => setTimeout(r, 200));
          if (cancelRequested) break;
        }

        const currentTask = chunkTasks[i];
        try {
          const buffer = await fetchImageBuffer(currentTask.url);

          if (isZip && zipInstance) {
            zipInstance.file(currentTask.filename, buffer);
          } else {
            downloadBufferDirectly(buffer, currentTask.filename);
          }
        } catch (err) {
          log('Skipped failed item:', currentTask.filename, err);
        }

        completedCount++;
        showProgress(completedCount, totalCount, 'Saved ' + currentTask.filename);
        await new Promise(r => setTimeout(r, 120));
      }

      if (cancelRequested) break;

      // 4. Save ZIP chunk if applicable
      if (isZip && zipInstance && Object.keys(zipInstance.files).length > 0) {
        showProgress(completedCount, totalCount, `Writing ZIP ${part + 1}/${totalParts}...`);
        try {
          const zipBlob = await zipInstance.generateAsync({
            type: 'blob',
            compression: 'STORE'
          });
          const partSuffix = totalParts > 1 ? `_part${part + 1}` : '';
          const zipName = `${baseTitle}_${timestamp}${partSuffix}.zip`;
          saveAs(zipBlob, zipName);
        } catch (zipErr) {
          log('ZIP Generation Error:', zipErr);
        }
        zipInstance = null;
      }
    }

    if (cancelRequested) {
      finishProcess('Download cancelled.');
      return;
    }

    finishProcess(`Done! Processed ${completedCount} files.`);
    if (CONFIG.notifyOnComplete && typeof GM_notification === 'function') {
      GM_notification({
        title: 'Pixiv Batch Downloader',
        text: `Completed ${completedCount} artworks!`,
        timeout: 4000
      });
    }
  }

  function finishProcess(message) {
    isDownloading = false;
    isPaused = false;
    cancelRequested = false;
    updateUIState();
    showProgress(completedCount, totalCount || completedCount, message);
    setTimeout(() => {
      if (!isDownloading) hideProgress();
    }, 5000);
  }

  let uiContainer = null;
  let progressBar = null;
  let statusText = null;

  function createInjectedUI() {
    if (document.getElementById('pixiv-batch-downloader-root')) return;

    uiContainer = document.createElement('div');
    uiContainer.id = 'pixiv-batch-downloader-root';

    const pos = CONFIG.floatingPosition;
    let posCss = 'bottom: 24px; right: 24px;';
    if (pos === 'bottom-left') posCss = 'bottom: 24px; left: 24px;';
    if (pos === 'top-right') posCss = 'top: 70px; right: 24px;';
    if (pos === 'top-left') posCss = 'top: 70px; left: 24px;';

    uiContainer.style.cssText = `
      position: fixed;
      ${posCss}
      z-index: 999999;
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 14px 18px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      min-width: 320px;
      max-width: 420px;
      font-size: 13px;
    `;

    uiContainer.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #38bdf8;"></span>
          <strong style="font-size: 14px; font-weight: 700; color: #fff;">Pixiv Batch Downloader</strong>
        </div>
        <button id="pbd-mode-tag" style="background: #1e293b; color: #38bdf8; border: 1px solid #475569; padding: 2px 8px; border-radius: 6px; font-size: 11px; text-transform: uppercase; cursor: pointer;">
          ${CONFIG.downloadMode}
        </button>
      </div>

      <div id="pbd-controls" style="display: flex; gap: 8px; margin-bottom: 8px;">
        <button id="pbd-btn-download" style="flex: 1; background: #0284c7; color: #fff; border: none; border-radius: 8px; padding: 8px 12px; font-weight: 600; cursor: pointer;">
          ⚡ Download This Page
        </button>
        <button id="pbd-btn-pause" style="display: none; background: #eab308; color: #000; border: none; border-radius: 8px; padding: 8px 12px; font-weight: 600; cursor: pointer;">
          Pause
        </button>
        <button id="pbd-btn-cancel" style="display: none; background: #ef4444; color: #fff; border: none; border-radius: 8px; padding: 8px 12px; font-weight: 600; cursor: pointer;">
          Cancel
        </button>
      </div>

      <div id="pbd-progress-container" style="display: none; margin-top: 8px;">
        <div style="width: 100%; height: 6px; background: #1e293b; border-radius: 99px; overflow: hidden;">
          <div id="pbd-progress-bar" style="width: 0%; height: 100%; background: #38bdf8; transition: width 0.2s;"></div>
        </div>
        <div id="pbd-status" style="margin-top: 6px; font-size: 11px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
          Ready
        </div>
      </div>
    `;

    document.body.appendChild(uiContainer);

    const dlBtn = document.getElementById('pbd-btn-download');
    const pauseBtn = document.getElementById('pbd-btn-pause');
    const cancelBtn = document.getElementById('pbd-btn-cancel');
    const modeTag = document.getElementById('pbd-mode-tag');
    progressBar = document.getElementById('pbd-progress-bar');
    statusText = document.getElementById('pbd-status');

    modeTag.addEventListener('click', () => {
      if (isDownloading) return;
      CONFIG.downloadMode = CONFIG.downloadMode === 'zip' ? 'direct' : 'zip';
      modeTag.innerText = CONFIG.downloadMode;
    });

    dlBtn.addEventListener('click', async () => {
      dlBtn.disabled = true;
      dlBtn.innerText = 'Scanning...';
      const ids = await scanCurrentPageArtworkIds();
      dlBtn.disabled = false;
      dlBtn.innerText = '⚡ Download This Page';

      if (!ids || ids.length === 0) {
        alert('No artworks found on this page. Scroll down to load images first.');
        return;
      }

      runBatchDownload(ids);
    });

    pauseBtn.addEventListener('click', () => {
      isPaused = !isPaused;
      pauseBtn.innerText = isPaused ? 'Resume' : 'Pause';
      statusText.innerText = isPaused ? 'Paused...' : 'Resuming...';
    });

    cancelBtn.addEventListener('click', () => {
      cancelRequested = true;
      finishProcess('Download cancelled.');
    });
  }

  function updateUIState() {
    const dlBtn = document.getElementById('pbd-btn-download');
    const pauseBtn = document.getElementById('pbd-btn-pause');
    const cancelBtn = document.getElementById('pbd-btn-cancel');
    const progressContainer = document.getElementById('pbd-progress-container');

    if (!dlBtn) return;

    if (isDownloading) {
      dlBtn.style.display = 'none';
      pauseBtn.style.display = 'inline-block';
      cancelBtn.style.display = 'inline-block';
      progressContainer.style.display = 'block';
    } else {
      dlBtn.style.display = 'inline-block';
      pauseBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
    }
  }

  function showProgress(current, total, text) {
    const progressContainer = document.getElementById('pbd-progress-container');
    if (progressContainer) progressContainer.style.display = 'block';

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    if (progressBar) progressBar.style.width = pct + '%';
    if (statusText) statusText.innerText = '[' + current + '/' + total + ' (' + pct + '%)] ' + text;
  }

  function hideProgress() {
    const progressContainer = document.getElementById('pbd-progress-container');
    if (progressContainer) progressContainer.style.display = 'none';
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⚡ Download Artworks on Current Page', async () => {
      const ids = await scanCurrentPageArtworkIds();
      if (ids.length > 0) runBatchDownload(ids);
    });
  }

  function init() {
    createInjectedUI();
    let lastUrl = location.href;
    new MutationObserver(() => {
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        createInjectedUI();
      }
    }).observe(document, { subtree: true, childList: true });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
