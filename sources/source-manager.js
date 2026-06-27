// ====================================================================
//  Mineradio 外部音源适配器核心
//  ====================================================================
//  每个音源导出 { id, name, type, search, songUrl, lyric, ... }
//  统一接口：所有 method 返回 song 对象格式：
//  {
//    provider: 'navidrome' | 'lx-custom-xxx',
//    source: 'navidrome' | 'lx-custom-xxx',
//    type: 'song',
//    id:        <source-native-id>,
//    name:      <title>,
//    artist:    <artist string>,
//    artists:   [{ name, id }],
//    album:     <album>,
//    cover:     <url>,
//    duration:  <ms>,
//    url:       <direct stream URL, or null to proxy>,
//    bitrate:   <bps, optional>,
//    format:    <'flac'|'mp3'|'m4a'|'ogg', optional>,
//    fee:       0,
//    playable:  true,
//  }
// ====================================================================

const fs = require('fs');
const path = require('path');

const SOURCES_DIR = __dirname;
const SOURCES_CONFIG_FILE = path.join(SOURCES_DIR, 'sources.json');

function loadSourcesConfig() {
  try {
    return JSON.parse(fs.readFileSync(SOURCES_CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.warn('[Sources] config load failed (will init default):', e.message);
    return { version: 1, sources: [], preferences: {} };
  }
}

function saveSourcesConfig(config) {
  try {
    fs.mkdirSync(SOURCES_DIR, { recursive: true });
    const payload = Object.assign({}, config, { _savedAt: new Date().toISOString() });
    fs.writeFileSync(SOURCES_CONFIG_FILE, JSON.stringify(payload, null, 2));
    return true;
  } catch (e) {
    console.error('[Sources] config save failed:', e.message);
    return false;
  }
}

// 加载所有适配器
const adapters = {};

function loadAdapter(adapterName) {
  if (adapters[adapterName]) return adapters[adapterName];

  // adapterName 可能是音源实例 ID (如 'navidrome-1234567890')，反查 type
  let actualName = adapterName;
  try {
    const cfg = loadSourcesConfig();
    const src = (cfg.sources || []).find(s => s.id === adapterName);
    if (src && src.type) actualName = src.type;
  } catch (e) {}

  // 配置文件中未找到（可能尚未保存），尝试从 ID 前缀推测
  // 'navidrome-1734567890' → 'navidrome',  'lx-custom-xxx' → 'lx-custom'
  if (actualName === adapterName && adapterName.includes('-')) {
    const prefix = adapterName.split('-')[0];
    // 对 lx-custom 特判: id 是 'lx-custom-<ts>', type 也是 'lx-custom'
    const maybeType = adapterName.startsWith('lx-custom-') ? 'lx-custom' : prefix;
    const probeFile = path.join(SOURCES_DIR, maybeType + '-adapter.js');
    if (fs.existsSync(probeFile)) actualName = maybeType;
  }

  if (adapters[actualName]) return adapters[actualName];

  try {
    const file = path.join(SOURCES_DIR, actualName + '-adapter.js');
    if (!fs.existsSync(file)) return null;
    const adapter = require(file);
    if (adapter && adapter.id) {
      adapters[actualName] = adapter;
      // 同时用原始名称缓存，避免重复反查
      if (actualName !== adapterName) adapters[adapterName] = adapter;
      console.log('[Sources] adapter loaded:', actualName);
    }
    return adapter;
  } catch (e) {
    console.error('[Sources] adapter load failed:', actualName, e.message);
    return null;
  }
}

function getEnabledSources(config) {
  const cfg = config || loadSourcesConfig();
  const sources = (cfg && cfg.sources) || [];
  const prefs = (cfg && cfg.preferences) || {};
  const order = prefs.playbackOrder || prefs.searchProviders || [];

  const enabled = sources
    .filter(s => s && s.enabled && s.id)
    .sort((a, b) => {
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return (b.priority || 0) - (a.priority || 0);
    });

  return enabled.map(s => {
    const adapter = loadAdapter(s.id);
    return { source: s, adapter, enabled: s.enabled && !!adapter };
  }).filter(s => s.enabled);
}

// ====================================================================
//  统一搜索 API
// ====================================================================
async function searchAllSources(keywords, limit, configOverride) {
  const config = configOverride || loadSourcesConfig();
  const enabled = getEnabledSources(config);
  const allSongs = [];
  const prefs = config.preferences || {};
  const perSourceLimit = Math.max(4, Math.min(30, parseInt(limit || prefs.maxResultsPerSource || 15) || 15));

  const results = await Promise.allSettled(
    enabled.map(async ({ source, adapter }) => {
      try {
        if (typeof adapter.search !== 'function') return [];
        const songs = await adapter.search(keywords, perSourceLimit, source.config);
        return (songs || []).map(s => Object.assign({}, s, {
          provider: adapter.id,
          source: source.id,           // 具体音源实例 ID，用于精确匹配配置
          sourceType: adapter.id,      // 适配器类型（navidrome/lx-custom），用于前端路由
          type: s.type || 'song',
          fee: 0,
        })).slice(0, perSourceLimit);
      } catch (err) {
        console.warn('[Sources] search failed for', adapter.id, ':', err.message);
        return [];
      }
    })
  );

  results.forEach(r => {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      r.value.forEach(s => allSongs.push(s));
    }
  });

  return deduplicateSongs(allSongs, limit);
}

function findSourceConfig(config, providerId) {
  const sources = (config && config.sources) || [];
  // 优先精确匹配 ID，其次按 type 匹配
  return sources.find(s => s.id === providerId) || sources.find(s => s.type === providerId);
}

// ====================================================================
//  统一取歌曲 URL
// ====================================================================
async function resolveSongUrl(song, qualityPreference, configOverride) {
  const config = configOverride || loadSourcesConfig();
  const providerId = song && (song.source || song.provider);
  const adapter = loadAdapter(providerId);
  if (!adapter || typeof adapter.songUrl !== 'function') return null;

  const sourceCfg = findSourceConfig(config, providerId);
  try {
    const info = await adapter.songUrl(song, qualityPreference, sourceCfg && sourceCfg.config);
    if (info && info.url) {
      return Object.assign({}, info, {
        provider: providerId,
        playable: true,
        trial: false,
      });
    }
    return null;
  } catch (err) {
    console.warn('[Sources] songUrl failed for', providerId, ':', err.message);
    return null;
  }
}

// ====================================================================
//  统一歌词
// ====================================================================
async function resolveLyric(song, configOverride) {
  const config = configOverride || loadSourcesConfig();
  const providerId = song && (song.source || song.provider);
  const adapter = loadAdapter(providerId);
  if (!adapter || typeof adapter.lyric !== 'function') return null;
  const sourceCfg = findSourceConfig(config, providerId);
  try {
    return await adapter.lyric(song, sourceCfg && sourceCfg.config);
  } catch (err) {
    console.warn('[Sources] lyric failed for', providerId, ':', err.message);
    return null;
  }
}

// ====================================================================
//  统一歌单
// ====================================================================
async function resolveUserPlaylists(providerId, configOverride) {
  const config = configOverride || loadSourcesConfig();
  const adapter = loadAdapter(providerId);
  if (!adapter || typeof adapter.playlists !== 'function') return [];
  const sourceCfg = (config.sources || []).find(s => s.id === providerId);
  try {
    const pls = await adapter.playlists(sourceCfg && sourceCfg.config);
    return pls.map(pl => Object.assign({}, pl, {
      provider: providerId,
      source: providerId,
    }));
  } catch (err) {
    console.warn('[Sources] playlists failed for', providerId, ':', err.message);
    return [];
  }
}

async function resolvePlaylistTracks(providerId, playlistId, configOverride) {
  const config = configOverride || loadSourcesConfig();
  const adapter = loadAdapter(providerId);
  if (!adapter || typeof adapter.playlistTracks !== 'function') return [];
  const sourceCfg = (config.sources || []).find(s => s.id === providerId);
  try {
    const tracks = await adapter.playlistTracks(playlistId, sourceCfg && sourceCfg.config);
    return tracks.map(t => Object.assign({}, t, {
      provider: providerId,
      source: providerId,
      type: t.type || 'song',
      fee: 0,
    }));
  } catch (err) {
    console.warn('[Sources] playlistTracks failed for', providerId, ':', err.message);
    return [];
  }
}

// ====================================================================
//  LX Music 音源加载器
// ====================================================================
function loadLXMusicSource(sourceFilePath, configOverride) {
  const config = configOverride || loadSourcesConfig();
  try {
    const absPath = path.resolve(sourceFilePath);
    if (!fs.existsSync(absPath)) {
      throw new Error('Source file not found: ' + absPath);
    }
    // LX Music 音源通常是 js 文件，导出包含 getMusicSources() 等方法
    // 我们在 sandbox 中执行
    const sourceModule = require(absPath);
    console.log('[LX-Source] loaded:', absPath);
    return sourceModule;
  } catch (e) {
    console.error('[LX-Source] load failed:', sourceFilePath, e.message);
    return null;
  }
}

// ====================================================================
//  LX Music 适配器（通用）
// ====================================================================
function createLXMusicAdapter(sourceId, sourceName, sourceFilePath, configOverride) {
  const manifest = loadLXMusicSource(sourceFilePath, configOverride);
  if (!manifest) return null;

  const adapter = {
    id: sourceId,
    name: sourceName,
    type: 'lx-custom',

    search: async function(keywords, limit, sourceConfig) {
      if (!manifest.getMusicSources || typeof manifest.getMusicSources !== 'function') return [];
      try {
        const sources = await manifest.getMusicSources();
        // LX Music 的 source 返回 [{ name, sources: [{ name, songs: [{ name, singer, album, duration, coverUrl, songUrl, lyricUrl }] }] }]
        if (!Array.isArray(sources)) return [];
        const allSongs = [];
        for (const group of sources) {
          const subs = Array.isArray(group.sources) ? group.sources : [group];
          for (const sub of subs) {
            const songs = Array.isArray(sub.songs) ? sub.songs : [];
            for (const raw of songs) {
              if (!raw || !raw.name) continue;
              allSongs.push({
                provider: sourceId,
                source: sourceId,
                type: 'song',
                id: raw.songUrl || raw.name + '|' + (raw.singer || ''),
                name: raw.name || '',
                artist: raw.singer || '',
                artists: [{ name: raw.singer || '' }],
                album: raw.album || '',
                cover: raw.coverUrl || raw.picUrl || '',
                duration: (Number(raw.duration) || 0) * 1000,
                url: raw.songUrl || '',
                bitrate: raw.bitrate || 0,
                format: raw.format || '',
                fee: 0,
                playable: !!raw.songUrl,
              });
            }
          }
        }
        return allSongs.slice(0, limit || 20);
      } catch (e) {
        console.warn('[LX-Adapter] search failed:', e.message);
        return [];
      }
    },

    songUrl: async function(song, quality) {
      if (song && song.url) {
        return {
          url: song.url,
          playable: true,
          trial: false,
          level: 'standard',
          quality: '标准',
        };
      }
      // 如果 song 对象没有预置 url，再尝试通过歌名+歌手实时获取
      if (!manifest.getMusicSources || typeof manifest.getMusicSources !== 'function') return null;
      try {
        const sources = await manifest.getMusicSources();
        for (const group of sources) {
          const subs = Array.isArray(group.sources) ? group.sources : [group];
          for (const sub of subs) {
            if (typeof sub.getMusicInfo === 'function') {
              const info = await sub.getMusicInfo(song);
              if (info && info.url) return { url: info.url, playable: true };
            }
            if (typeof sub.getMusicUrl === 'function') {
              const url = await sub.getMusicUrl(song.id || song);
              if (url) return { url, playable: true };
            }
          }
        }
      } catch (e) {
        console.warn('[LX-Adapter] songUrl failed:', e.message);
      }
      return null;
    },

    lyric: async function(song) {
      if (song && song.lyricUrl) {
        try {
          const resp = await fetch(song.lyricUrl);
          const text = await resp.text();
          return { lyric: text, tlyric: '', source: sourceId };
        } catch (e) {
          console.warn('[LX-Adapter] lyric fetch failed:', e.message);
        }
      }
      // 尝试走 LX Music 歌词获取路径
      if (!manifest.getMusicSources || typeof manifest.getMusicSources !== 'function') return null;
      try {
        const sources = await manifest.getMusicSources();
        for (const group of sources) {
          const subs = Array.isArray(group.sources) ? group.sources : [group];
          for (const sub of subs) {
            if (typeof sub.getLyric === 'function') {
              const lyric = await sub.getLyric(song);
              if (lyric) return { lyric, tlyric: '', source: sourceId };
            }
          }
        }
      } catch (e) {}
      return null;
    },

    playlists: async function(config) {
      if (manifest.getUserPlaylists && typeof manifest.getUserPlaylists === 'function') {
        try {
          const raw = await manifest.getUserPlaylists(config);
          return (raw || []).map(pl => ({
            id: pl.id || pl.playlistId || '',
            name: pl.name || pl.title || '',
            cover: pl.cover || pl.picUrl || '',
            trackCount: pl.trackCount || pl.songCount || 0,
            playCount: 0,
            creator: pl.creator || pl.author || '',
          }));
        } catch (e) {
          console.warn('[LX-Adapter] playlists failed:', e.message);
        }
      }
      return [];
    },

    playlistTracks: async function(playlistId, config) {
      if (manifest.getPlaylistDetail && typeof manifest.getPlaylistDetail === 'function') {
        try {
          const songs = await manifest.getPlaylistDetail(playlistId, config);
          return (songs || []).map(s => ({
            id: s.songUrl || s.id || '',
            name: s.name || '',
            artist: s.singer || '',
            artists: [{ name: s.singer || '' }],
            album: s.album || '',
            cover: s.coverUrl || s.picUrl || '',
            duration: (Number(s.duration) || 0) * 1000,
            url: s.songUrl || '',
            fee: 0,
            playable: !!s.songUrl,
          }));
        } catch (e) {
          console.warn('[LX-Adapter] playlistTracks failed:', e.message);
        }
      }
      return [];
    },

    // 登录态
    login: async function(config) {
      if (manifest.login && typeof manifest.login === 'function') {
        try {
          return await manifest.login(config);
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      return { ok: true, loggedIn: false, message: 'No login required' };
    },

    loginStatus: async function(config) {
      if (manifest.getLoginStatus && typeof manifest.getLoginStatus === 'function') {
        try { return await manifest.getLoginStatus(config); }
        catch (e) { return { loggedIn: false }; }
      }
      return { loggedIn: false };
    },
  };

  return adapter;
}

// ====================================================================
//  工具函数
// ====================================================================
function deduplicateSongs(songs, limit) {
  const seen = new Set();
  const out = [];
  for (const song of (songs || [])) {
    if (!song || !song.name) continue;
    const key = (song.provider || song.source || '') + '|' + (song.id || '') + '|' + (song.name || '');
    const nameKey = (song.name || '').toLowerCase() + '||' + (song.artist || '').toLowerCase();
    if (seen.has(key) || seen.has(nameKey)) continue;
    seen.add(key);
    seen.add(nameKey);
    out.push(song);
  }
  return out.slice(0, limit || 20);
}

function proxyAudioUrl(directUrl) {
  if (!directUrl || !/^https?:\/\//i.test(directUrl)) return directUrl;
  return '/api/audio?url=' + encodeURIComponent(directUrl);
}

module.exports = {
  loadSourcesConfig,
  saveSourcesConfig,
  getEnabledSources,
  loadAdapter,
  findSourceConfig,
  searchAllSources,
  resolveSongUrl,
  resolveLyric,
  resolveUserPlaylists,
  resolvePlaylistTracks,
  loadLXMusicSource,
  createLXMusicAdapter,
  deduplicateSongs,
  proxyAudioUrl,
};
