// ============================================================================
// 라쿠너스 인기 클립 박제관 (CHZZK CLIP ARCHIVE) - 실시간 동기화 & 자동 병합 엔진
// ============================================================================

const CHANNEL_ID = "a4a172706bed9152f18df8796bde093b";
const BOOKMARK_STORAGE_KEY = "rcns_clip_bookmarks_v1";
const CUSTOM_CLIPS_STORAGE_KEY = "rcns_custom_clips_v1";
const LIVE_CACHE_STORAGE_KEY = "rcns_live_synced_clips_v2";
const LIVE_META_STORAGE_KEY = "rcns_live_synced_meta_v2";
const PAGE_SIZE = 40;

let allClips = [];
let filteredClips = [];
let visibleCount = PAGE_SIZE;
let currentClipUID = null;
let currentTheme = "ALL";
let bookmarkedUIDs = new Set();
let isSyncing = false;

// 다중 CORS 프록시 체인
const CORS_PROXY_BUILDERS = [
  (url) => `https://proxy.corsfix.com/?${url}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${url}`
];

// 1단계: 브라우저 캐시를 우회하여 최신 clips-data.js 재로드 (GitHub Actions 자동 갱신분 즉시 반영)
function reloadClipsDataScript() {
  return new Promise((resolve) => {
    const oldScript = document.getElementById("dynamicClipsDataScript");
    if (oldScript) oldScript.remove();

    const script = document.createElement("script");
    script.id = "dynamicClipsDataScript";
    script.src = `clips-data.js?t=${Date.now()}`;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
}

async function fetchChzzkJsonWithProxy(targetUrl, timeoutMs = 5500) {
  let lastError = null;

  for (const buildProxyUrl of CORS_PROXY_BUILDERS) {
    const proxiedUrl = buildProxyUrl(targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(proxiedUrl, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      if (data && (data.code === 200 || data.content)) {
        return data.content ?? data;
      }
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }

  throw lastError || new Error("모든 CORS 프록시 연결 실패");
}

function normalizeClipItem(item, existing) {
  return {
    clipUID: item.clipUID,
    videoId: item.videoId ?? existing?.videoId ?? "",
    clipTitle: item.clipTitle ?? existing?.clipTitle ?? "",
    thumbnailImageUrl: item.thumbnailImageUrl ?? existing?.thumbnailImageUrl ?? null,
    categoryType: item.categoryType ?? existing?.categoryType ?? null,
    clipCategory: item.clipCategory ?? existing?.clipCategory ?? null,
    duration: item.duration ?? existing?.duration ?? 0,
    adult: Boolean(item.adult ?? existing?.adult),
    createdDate: item.createdDate ?? existing?.createdDate ?? "",
    readCount: Math.max(Number(item.readCount) || 0, Number(existing?.readCount) || 0)
  };
}

function saveLiveClipsToStorage(clipMap) {
  const mergedLiveArray = [...clipMap.values()].sort((a, b) => {
    const diff = (b.readCount || 0) - (a.readCount || 0);
    if (diff !== 0) return diff;
    return String(b.createdDate || "").localeCompare(String(a.createdDate || ""));
  });

  const syncTimeStr = new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  localStorage.setItem(
    LIVE_CACHE_STORAGE_KEY,
    JSON.stringify({
      syncedAt: syncTimeStr,
      clips: mergedLiveArray
    })
  );

  return syncTimeStr;
}

// 치지직 API 및 최신 clips-data.js에서 실시간 클립·조회수 동기화
async function syncFromChzzkLive(manualTrigger = false) {
  if (isSyncing) return;
  isSyncing = true;

  const syncBtn = document.getElementById("syncNowBtn");
  const syncStatusText = document.getElementById("syncStatusText");
  const prevTotalCount = allClips.length;

  syncBtn.classList.add("syncing");
  syncBtn.textContent = "⏳ 동기화 중...";
  syncStatusText.textContent = "🔄 최신 클립 및 실시간 조회수 확인 중...";

  try {
    // Step 0: 캐시 우회하여 최신 clips-data.js 다시 읽기 (GitHub Actions가 갱신한 데이터 즉시 반영)
    await reloadClipsDataScript();
    loadUserData();
    renderHeaderAndTop5();
    applyFiltersAndRender(false);
    refreshCurrentPlayingInfo();

    // 현재 보유한 모든 클립을 Map으로 준비
    const workingMap = new Map();
    for (const c of allClips) {
      workingMap.set(c.clipUID, c);
    }

    // Step 1: 가장 중요한 '최신순(RECENT) 1~2페이지'부터 최우선 호출! (방금 생성된 클립 즉시 확보)
    let nextRecentUID = null;
    let proxySucceeded = false;

    for (let page = 0; page < 2; page++) {
      let recentUrl = `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?filterType=ALL&orderType=RECENT&size=50`;
      if (nextRecentUID) {
        recentUrl += `&clipUID=${encodeURIComponent(nextRecentUID)}`;
      }
      const recentContent = await fetchChzzkJsonWithProxy(recentUrl);
      const list = recentContent?.data || [];
      if (!list.length) break;

      proxySucceeded = true;
      for (const item of list) {
        workingMap.set(item.clipUID, normalizeClipItem(item, workingMap.get(item.clipUID)));
      }

      // 최신 클립 확보 즉시 중간 저장 & UI 갱신
      const syncTimeStr = saveLiveClipsToStorage(workingMap);
      loadUserData();
      renderHeaderAndTop5();
      applyFiltersAndRender(false);
      refreshCurrentPlayingInfo();
      syncStatusText.textContent = `🟢 실시간 최신 클립 반영됨 (${syncTimeStr} · 총 ${allClips.length}개)`;

      if (!recentContent?.page?.next?.clipUID) break;
      nextRecentUID = recentContent.page.next.clipUID;
    }

    // Step 2: 채널 생방송 상태 및 팔로워 수 조회
    try {
      const chInfo = await fetchChzzkJsonWithProxy(
        `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}`
      );
      if (chInfo) {
        applyChannelMeta(chInfo);
        localStorage.setItem(
          LIVE_META_STORAGE_KEY,
          JSON.stringify({
            followerCount: chInfo.followerCount,
            openLive: chInfo.openLive,
            channelImageUrl: chInfo.channelImageUrl,
            updatedAt: new Date().toISOString()
          })
        );
      }
    } catch (chErr) {
      // 채널 메타 실패는 무시하고 진행
    }

    // Step 3: 인기순(POPULAR) 페이지 순회하여 전체 클립 실시간 조회수 업데이트
    let nextPopUID = null;
    let nextReadCount = null;

    for (let page = 0; page < 6; page++) {
      let popUrl = `https://api.chzzk.naver.com/service/v1/channels/${CHANNEL_ID}/clips?filterType=ALL&orderType=POPULAR&size=50`;
      if (nextPopUID) {
        popUrl += `&clipUID=${encodeURIComponent(nextPopUID)}&readCount=${encodeURIComponent(nextReadCount ?? "")}`;
      }

      const popContent = await fetchChzzkJsonWithProxy(popUrl);
      const list = popContent?.data || [];
      if (!list.length) break;

      proxySucceeded = true;
      for (const item of list) {
        workingMap.set(item.clipUID, normalizeClipItem(item, workingMap.get(item.clipUID)));
      }

      if (!popContent?.page?.next?.clipUID) break;
      nextPopUID = popContent.page.next.clipUID;
      nextReadCount = popContent.page.next.readCount;
    }

    if (proxySucceeded) {
      const syncTimeStr = saveLiveClipsToStorage(workingMap);
      loadUserData();
      renderHeaderAndTop5();
      applyFiltersAndRender(false);
      refreshCurrentPlayingInfo();

      const addedDiff = Math.max(0, allClips.length - prevTotalCount);
      const diffMsg = addedDiff > 0 ? ` · 🆕 신규 +${addedDiff}개!` : "";
      syncStatusText.textContent = `🟢 실시간 동기화 완료 (${syncTimeStr} · 총 ${allClips.length}개${diffMsg})`;
      document.getElementById("lastSyncTimeHint").textContent =
        `✅ 치지직 공식 데이터와 실시간 동기화됨 (마지막 갱신: ${syncTimeStr})`;
    }
  } catch (err) {
    console.warn("프록시 실시간 호출 제한, 최신 clips-data.js 데이터를 표시합니다:", err);
    const metaTime = window.RCNS_CHANNEL_META?.updatedAt
      ? window.RCNS_CHANNEL_META.updatedAt.slice(0, 16).replace("T", " ")
      : "최신";
    syncStatusText.textContent = `🟢 자동 갱신 데이터 적용됨 (기준: ${metaTime} · 총 ${allClips.length}개)`;
  } finally {
    isSyncing = false;
    syncBtn.classList.remove("syncing");
    syncBtn.textContent = "🔄 실시간 동기화";
  }
}

function applyChannelMeta(meta) {
  if (!meta) return;
  if (typeof meta.followerCount === "number") {
    document.getElementById("followerStatBadge").textContent =
      `팔로워 ${meta.followerCount.toLocaleString()}명`;
  }
  const liveBadge = document.getElementById("liveChannelBadge");
  if (meta.openLive) {
    liveBadge.classList.remove("hidden");
  } else {
    liveBadge.classList.add("hidden");
  }
  if (meta.channelImageUrl) {
    document.getElementById("channelAvatarImg").src = meta.channelImageUrl;
  }
}

// clips-data.js + 실시간 로컬 캐시 + 수동 등록 클립을 손실 없이 병합
function loadUserData() {
  try {
    const savedBookmarks = JSON.parse(localStorage.getItem(BOOKMARK_STORAGE_KEY) || "[]");
    bookmarkedUIDs = new Set(savedBookmarks);
  } catch (e) {
    bookmarkedUIDs = new Set();
  }

  if (window.RCNS_CHANNEL_META) {
    applyChannelMeta(window.RCNS_CHANNEL_META);
  }

  try {
    const savedMeta = JSON.parse(localStorage.getItem(LIVE_META_STORAGE_KEY) || "null");
    if (savedMeta) applyChannelMeta(savedMeta);
  } catch (e) {
    // 무시
  }

  let customClips = [];
  try {
    customClips = JSON.parse(localStorage.getItem(CUSTOM_CLIPS_STORAGE_KEY) || "[]");
  } catch (e) {
    customClips = [];
  }

  const staticClips = Array.isArray(window.RCNS_CLIPS) ? window.RCNS_CLIPS : [];
  let cachedClips = [];
  try {
    const cachedLive = JSON.parse(localStorage.getItem(LIVE_CACHE_STORAGE_KEY) || "null");
    if (cachedLive && Array.isArray(cachedLive.clips)) {
      cachedClips = cachedLive.clips;
    }
  } catch (e) {
    cachedClips = [];
  }

  // 중요: 덮어쓰지 않고 staticClips + cachedClips + customClips를 clipUID 기준으로 완전 병합!
  const map = new Map();
  for (const c of staticClips) {
    if (c && c.clipUID) map.set(c.clipUID, c);
  }
  for (const c of cachedClips) {
    if (c && c.clipUID) {
      map.set(c.clipUID, normalizeClipItem(c, map.get(c.clipUID)));
    }
  }
  for (const c of customClips) {
    if (c && c.clipUID && !map.has(c.clipUID)) {
      map.set(c.clipUID, c);
    }
  }

  const merged = [...map.values()];

  // 인기순 기준 전체 랭킹 번호 부여
  const sortedByPopular = [...merged].sort((a, b) => {
    const diff = (b.readCount || 0) - (a.readCount || 0);
    if (diff !== 0) return diff;
    return String(b.createdDate || "").localeCompare(String(a.createdDate || ""));
  });

  const rankMap = new Map();
  sortedByPopular.forEach((item, idx) => {
    rankMap.set(item.clipUID, idx + 1);
  });

  // 최신 클립(최근 7일 이내 생성) 판별
  const nowMs = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  allClips = merged.map((clip) => {
    const createdMs = clip.createdDate ? new Date(clip.createdDate.replace(" ", "T")).getTime() : 0;
    const isRecentNew = createdMs > 0 && nowMs - createdMs <= sevenDaysMs;
    return {
      ...clip,
      popularRank: rankMap.get(clip.clipUID) || 999,
      isRecentNew,
      goroshiTheme: detectGoroshiTheme(clip)
    };
  });
}

function saveBookmarks() {
  localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify([...bookmarkedUIDs]));
  document.getElementById("bookmarkCountBadge").textContent = bookmarkedUIDs.size;
}

// 클립 제목/카테고리 기반 고로시 테마 자동 분류
function detectGoroshiTheme(clip) {
  const t = (clip.clipTitle || "").toLowerCase();

  if (/아저씨|아찌|아재|오지상|삼촌/.test(t)) {
    return { code: "AJUSSI", label: "🧔 아저씨 시리즈" };
  }
  if (/야레야레|아가씨|모에|큐우|엣큥|앙탈|매혹|다메|애교|귀여|뽀뽀|사랑해|재우기|도련님|메이드|변신|영창|하읏|앙~|뀽|오이시쿠|주문|키스|돌핀/.test(t)) {
    return { code: "AEGYO", label: "💖 애교·모에·영창" };
  }
  if (/절규|반찬|비명|극대노|괴롭|아쫌|고장|그랜절|납치|최악|매도|잔소리|희롱|살려/.test(t)) {
    return { code: "SCREAM", label: "😱 절규·반찬·급발진" };
  }
  if (clip.clipCategory === "art" || clip.categoryType === "GAME" || (clip.clipCategory && clip.clipCategory !== "talk")) {
    return { code: "ART_GAME", label: "🎨 그림 & 🎮 게임" };
  }
  return { code: "TALK", label: "🗣️ 주저리·일상" };
}

function formatCategoryLabel(clip) {
  if (clip.clipCategory === "art") return "🎨 그림/아트";
  if (clip.clipCategory === "talk") return "💬 소통/저챗";
  if (clip.categoryType === "GAME" || clip.clipCategory) {
    return `🎮 ${clip.clipCategory.replace(/_/g, " ")}`;
  }
  return "📺 하이라이트";
}

function formatDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return mins > 0 ? `${mins}:${String(rem).padStart(2, "0")}` : `0:${String(rem).padStart(2, "0")}`;
}

function formatDateOnly(dateStr) {
  if (!dateStr) return "-";
  return dateStr.split(" ")[0];
}

// 상단 요약 스탯 및 TOP 5 직행열차 렌더링
function renderHeaderAndTop5() {
  const totalViews = allClips.reduce((sum, c) => sum + (Number(c.readCount) || 0), 0);
  const newClipsCount = allClips.filter((c) => c.isRecentNew).length;

  document.getElementById("totalClipsStat").textContent = `${allClips.length.toLocaleString()}개`;
  document.getElementById("totalViewsStat").textContent = `${totalViews.toLocaleString()}회`;
  document.getElementById("bookmarkCountBadge").textContent = bookmarkedUIDs.size;
  const newBadgeEl = document.getElementById("newClipsCountBadge");
  if (newBadgeEl) {
    newBadgeEl.textContent = newClipsCount;
  }

  const top5 = [...allClips].sort((a, b) => a.popularRank - b.popularRank).slice(0, 5);
  const top5Container = document.getElementById("quickTop5List");
  top5Container.innerHTML = top5
    .map(
      (c) => `
      <div class="top5-item" data-play-uid="${c.clipUID}">
        <span class="top5-item-title"><strong>#${c.popularRank}</strong> ${escapeHtml(c.clipTitle)}</span>
        <span class="top5-item-views">👁️ ${(c.readCount || 0).toLocaleString()}</span>
      </div>
    `
    )
    .join("");

  top5Container.querySelectorAll("[data-play-uid]").forEach((el) => {
    el.addEventListener("click", () => {
      playClip(el.getAttribute("data-play-uid"), false);
    });
  });
}

// 현재 재생 중인 클립 메타 정보만 부드럽게 갱신
function refreshCurrentPlayingInfo() {
  if (!currentClipUID) return;
  const target = allClips.find((c) => c.clipUID === currentClipUID);
  if (!target) return;

  document.getElementById("currentRankBadge").textContent = `인기 #${target.popularRank}`;
  document.getElementById("currentCatBadge").textContent = formatCategoryLabel(target);
  document.getElementById("currentThemeBadge").textContent = target.goroshiTheme.label;
  document.getElementById("currentClipTitle").textContent = target.clipTitle;
  document.getElementById("currentReadCount").textContent = (target.readCount || 0).toLocaleString();
  document.getElementById("currentDuration").textContent = `${target.duration || 0}초`;
  document.getElementById("currentDate").textContent = target.createdDate || "-";
}

// 특정 클립을 시어터 플레이어에서 재생
function playClip(clipUID, scrollToTop = true) {
  const target = allClips.find((c) => c.clipUID === clipUID);
  if (!target) return;

  currentClipUID = target.clipUID;

  const iframe = document.getElementById("clipIframe");
  iframe.src = `https://chzzk.naver.com/embed/clip/${encodeURIComponent(target.clipUID)}`;

  refreshCurrentPlayingInfo();
  document.getElementById("openOriginalClipLink").href = `https://chzzk.naver.com/clips/${encodeURIComponent(target.clipUID)}`;

  updateBookmarkButtonState();

  document.querySelectorAll(".clip-card").forEach((card) => {
    const uid = card.getAttribute("data-uid");
    card.classList.toggle("playing", uid === currentClipUID);
  });

  if (scrollToTop) {
    document.getElementById("theaterSection").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function updateBookmarkButtonState() {
  const btn = document.getElementById("toggleBookmarkBtn");
  const isBookmarked = bookmarkedUIDs.has(currentClipUID);
  btn.classList.toggle("bookmarked", isBookmarked);
  btn.textContent = isBookmarked ? "⭐ 내 박제함에 보관됨 (클릭 시 해제)" : "⭐ 내 박제함에 찜하기";
}

// 필터링 & 정렬 적용
function applyFiltersAndRender(resetVisible = true) {
  if (resetVisible) {
    visibleCount = PAGE_SIZE;
  }

  const keyword = document.getElementById("searchInput").value.trim().toLowerCase();
  const showAdult = document.getElementById("showAdultToggle").checked;
  const sortBy = document.getElementById("sortSelect").value;

  filteredClips = allClips.filter((clip) => {
    if (!showAdult && clip.adult) return false;

    if (currentTheme === "TOP30" && clip.popularRank > 30) return false;
    if (currentTheme === "AJUSSI" && clip.goroshiTheme.code !== "AJUSSI") return false;
    if (currentTheme === "AEGYO" && clip.goroshiTheme.code !== "AEGYO") return false;
    if (currentTheme === "SCREAM" && clip.goroshiTheme.code !== "SCREAM") return false;
    if (currentTheme === "ART_GAME") {
      const isArtOrGame =
        clip.clipCategory === "art" ||
        clip.categoryType === "GAME" ||
        (clip.clipCategory && clip.clipCategory !== "talk");
      if (!isArtOrGame) return false;
    }
    if (currentTheme === "BOOKMARK" && !bookmarkedUIDs.has(clip.clipUID)) return false;

    if (keyword) {
      const inTitle = (clip.clipTitle || "").toLowerCase().includes(keyword);
      const inCat = (clip.clipCategory || "").toLowerCase().includes(keyword);
      if (!inTitle && !inCat) return false;
    }

    return true;
  });

  // '🆕 최신 클립' 탭이 선택된 경우 항상 최신 등록순을 우선 적용해 방금 올라온 클립이 맨 위에 보이도록 처리
  const effectiveSort = currentTheme === "RECENT_NEW" ? "newest" : sortBy;

  filteredClips.sort((a, b) => {
    if (effectiveSort === "popular") {
      const diff = (b.readCount || 0) - (a.readCount || 0);
      if (diff !== 0) return diff;
      return String(b.createdDate || "").localeCompare(String(a.createdDate || ""));
    }
    if (effectiveSort === "newest") return String(b.createdDate || "").localeCompare(String(a.createdDate || ""));
    if (effectiveSort === "oldest") return String(a.createdDate || "").localeCompare(String(b.createdDate || ""));
    if (effectiveSort === "shortest") return (a.duration || 0) - (b.duration || 0);
    return 0;
  });

  document.getElementById("filteredCountText").textContent = filteredClips.length.toLocaleString();
  renderClipsGrid();
}

function renderClipsGrid() {
  const grid = document.getElementById("clipsGrid");
  const loadMoreBtn = document.getElementById("loadMoreBtn");

  if (filteredClips.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px 20px; color: var(--text-secondary);">
        조건에 맞는 클립이 없습니다. 다른 테마 탭이나 검색어를 입력해보세요!
      </div>
    `;
    loadMoreBtn.classList.add("hidden");
    return;
  }

  const slice = filteredClips.slice(0, visibleCount);

  grid.innerHTML = slice
    .map((clip) => {
      const isPlaying = clip.clipUID === currentClipUID;
      const isBookmarked = bookmarkedUIDs.has(clip.clipUID);
      let rankClass = "";
      if (clip.popularRank === 1) rankClass = "top1";
      else if (clip.popularRank === 2) rankClass = "top2";
      else if (clip.popularRank === 3) rankClass = "top3";

      const thumbHtml = clip.thumbnailImageUrl
        ? `<img src="${escapeHtml(clip.thumbnailImageUrl)}" alt="${escapeHtml(clip.clipTitle)}" class="thumb-img" loading="lazy" />`
        : `<div class="thumb-fallback"><span>🦝</span><span>${clip.adult ? "🔞 성인 인증 클립" : "치지직 클립"}</span></div>`;

      return `
        <article class="clip-card ${isPlaying ? "playing" : ""}" data-uid="${clip.clipUID}">
          <div class="thumb-wrap">
            ${thumbHtml}
            <span class="thumb-rank-badge ${rankClass}">#${clip.popularRank}</span>
            ${clip.isRecentNew ? `<span class="thumb-new-badge">NEW</span>` : ""}
            ${clip.adult ? `<span class="thumb-adult">19</span>` : ""}
            ${isPlaying ? `<span class="playing-indicator">▶ 재생 중</span>` : ""}
            <span class="thumb-duration">${formatDuration(clip.duration)}</span>
          </div>
          <div class="card-body">
            <div>
              <h3 class="card-title">${escapeHtml(clip.clipTitle)}</h3>
            </div>
            <div class="card-footer">
              <div>
                <span class="card-views">👁️ ${(clip.readCount || 0).toLocaleString()}회</span>
                <span> · ${formatDateOnly(clip.createdDate)}</span>
              </div>
              <button
                type="button"
                class="card-bookmark-btn ${isBookmarked ? "active" : ""}"
                data-bookmark-uid="${clip.clipUID}"
                title="내 박제함에 찜하기"
              >${isBookmarked ? "⭐ 찜됨" : "☆ 찜"}</button>
            </div>
          </div>
        </article>
      `;
    })
    .join("");

  grid.querySelectorAll(".clip-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-bookmark-uid]")) return;
      const uid = card.getAttribute("data-uid");
      playClip(uid, true);
    });
  });

  grid.querySelectorAll("[data-bookmark-uid]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const uid = btn.getAttribute("data-bookmark-uid");
      toggleBookmark(uid);
    });
  });

  if (filteredClips.length > visibleCount) {
    loadMoreBtn.classList.remove("hidden");
    loadMoreBtn.textContent = `클립 더 불러오기 (${visibleCount} / ${filteredClips.length})`;
  } else {
    loadMoreBtn.classList.add("hidden");
  }
}

function toggleBookmark(uid) {
  if (!uid) return;
  if (bookmarkedUIDs.has(uid)) {
    bookmarkedUIDs.delete(uid);
  } else {
    bookmarkedUIDs.add(uid);
  }
  saveBookmarks();
  updateBookmarkButtonState();
  applyFiltersAndRender(false);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================================
// 초기화 & 이벤트 리스너
// ============================================================================
function init() {
  loadUserData();
  renderHeaderAndTop5();
  applyFiltersAndRender(true);

  if (filteredClips.length > 0) {
    playClip(filteredClips[0].clipUID, false);
  }

  // 페이지 진입 시 백그라운드 실시간 동기화 실행 + 3분마다 자동 갱신
  syncFromChzzkLive(false);
  setInterval(() => syncFromChzzkLive(false), 3 * 60 * 1000);

  // 수동 실시간 동기화 버튼
  document.getElementById("syncNowBtn").addEventListener("click", () => {
    syncFromChzzkLive(true);
  });

  // 테마 탭 클릭
  document.querySelectorAll("#themeTabs .theme-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#themeTabs .theme-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentTheme = tab.getAttribute("data-theme");
      if (currentTheme === "RECENT_NEW") {
        document.getElementById("sortSelect").value = "newest";
      }
      applyFiltersAndRender(true);
    });
  });

  // 검색, 정렬, 연령제한 토글
  document.getElementById("searchInput").addEventListener("input", () => applyFiltersAndRender(true));
  document.getElementById("sortSelect").addEventListener("change", () => applyFiltersAndRender(true));
  document.getElementById("showAdultToggle").addEventListener("change", () => applyFiltersAndRender(true));

  // 더보기 버튼
  document.getElementById("loadMoreBtn").addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    renderClipsGrid();
  });

  // 이전 / 다음 클립 버튼
  document.getElementById("prevClipBtn").addEventListener("click", () => {
    if (!filteredClips.length) return;
    const idx = filteredClips.findIndex((c) => c.clipUID === currentClipUID);
    const prevIdx = idx > 0 ? idx - 1 : filteredClips.length - 1;
    playClip(filteredClips[prevIdx].clipUID, false);
  });

  document.getElementById("nextClipBtn").addEventListener("click", () => {
    if (!filteredClips.length) return;
    const idx = filteredClips.findIndex((c) => c.clipUID === currentClipUID);
    const nextIdx = idx >= 0 && idx < filteredClips.length - 1 ? idx + 1 : 0;
    playClip(filteredClips[nextIdx].clipUID, false);
  });

  // 랜덤 고로시 클립 뽑기
  document.getElementById("randomClipBtn").addEventListener("click", () => {
    const pool = filteredClips.length > 0 ? filteredClips : allClips;
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    playClip(pick.clipUID, true);
  });

  // 상단 플레이어 찜하기 버튼
  document.getElementById("toggleBookmarkBtn").addEventListener("click", () => {
    toggleBookmark(currentClipUID);
  });

  // 채팅/도네용 클립 링크 복사
  document.getElementById("copyShareTextBtn").addEventListener("click", (e) => {
    const target = allClips.find((c) => c.clipUID === currentClipUID);
    if (!target) return;
    const shareStr = `🎬 [라쿠너스 인기 클립 #${target.popularRank}] ${target.clipTitle} (조회수 ${target.readCount}회) 👉 https://chzzk.naver.com/clips/${target.clipUID}`;
    navigator.clipboard?.writeText(shareStr);
    const btn = e.currentTarget;
    btn.textContent = "✅ 클립 제목+링크 복사 완료!";
    setTimeout(() => {
      btn.textContent = "📋 채팅/도네용 링크 복사";
    }, 1500);
  });

  // 새 클립 수동 등록 모달
  const modal = document.getElementById("addClipModal");
  document.getElementById("openAddClipModalBtn").addEventListener("click", () => {
    document.getElementById("addClipForm").reset();
    modal.classList.remove("hidden");
  });
  document.getElementById("closeAddClipModalBtn").addEventListener("click", () => modal.classList.add("hidden"));
  document.getElementById("cancelAddClipBtn").addEventListener("click", () => modal.classList.add("hidden"));

  document.getElementById("addClipForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const rawUrl = document.getElementById("newClipUrlInput").value.trim();
    const title = document.getElementById("newClipTitleInput").value.trim();
    const duration = Number(document.getElementById("newClipDurationInput").value) || 30;

    const match = rawUrl.match(/clips\/([A-Za-z0-9_-]+)/);
    const clipUID = match ? match[1] : rawUrl;

    if (!clipUID || clipUID.length < 5) {
      alert("유효한 치지직 클립 주소 또는 클립 UID를 입력해주세요.");
      return;
    }

    const newClip = {
      clipUID,
      videoId: "",
      clipTitle: title,
      thumbnailImageUrl: null,
      categoryType: "ETC",
      clipCategory: "talk",
      duration,
      adult: false,
      createdDate: new Date().toISOString().slice(0, 19).replace("T", " "),
      readCount: 1
    };

    let customClips = [];
    try {
      customClips = JSON.parse(localStorage.getItem(CUSTOM_CLIPS_STORAGE_KEY) || "[]");
    } catch (err) {
      customClips = [];
    }
    customClips.unshift(newClip);
    localStorage.setItem(CUSTOM_CLIPS_STORAGE_KEY, JSON.stringify(customClips));

    modal.classList.add("hidden");
    loadUserData();
    renderHeaderAndTop5();
    applyFiltersAndRender(true);
    playClip(clipUID, true);
  });
}

window.addEventListener("DOMContentLoaded", init);
