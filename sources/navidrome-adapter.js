// ====================================================================
//  Navidrome 适配器 (Subsonic / OpenSubsonic REST API)
// ====================================================================
//  参考: http://www.subsonic.org/pages/api.jsp
//  Navidrome 兼容 Subsonic API，额外扩展了 OpenSubsonic 端点
// ====================================================================

const crypto = require('crypto');

const authCache = new Map(); // key: baseUrl|username → { query, time }
const SALT_CACHE_TTL = 55 * 1000; // salt 1min 内可重用

function authCacheKey(config) {
  return ((config && config.baseUrl) || '') + '|' + ((config && config.username) || '');
}

function md5hex(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

function randomSalt() {
  return Math.random().toString(36).slice(2, 10);
}

function buildAuthQuery(config) {
  const salt = randomSalt();
  const token = md5hex(config.password + salt);
  return {
    u: config.username,
    t: token,
    s: salt,
    v: config.clientVersion || '1.16.0',
    c: 'Mineradio',
    f: config.format || 'json',
  };
}

function buildAuthCacheKey(config) {
  const salt = randomSalt();
  const token = md5hex(config.password + salt);
  const u = encodeURIComponent(config.username);
  return `u=${u}&t=${token}&s=${salt}&v=${config.clientVersion || '1.16.0'}&c=Mineradio&f=json`;
}

function cacheAuth(config) {
  const now = Date.now();
  const key = authCacheKey(config);
  const entry = authCache.get(key);
  if (entry && (now - entry.time) < SALT_CACHE_TTL) {
    return entry.query;
  }
  const query = buildAuthCacheKey(config);
  authCache.set(key, { query, time: now });
  return query;
}

function normalizeBaseUrl(input) {
  let url = (input || '').trim().replace(/\/+$/, '').replace(/\/rest$/, '');
  try {
    const u = new URL(url);
    // 去掉默认端口 (443/80)
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = '';
    }
    url = u.toString().replace(/\/+$/, '');
  } catch (e) {}
  return url;
}

function subsonicUrl(config, endpoint, params) {
  const base = normalizeBaseUrl(config.baseUrl || '');
  const auth = cacheAuth(config);
  const query = Object.keys(params || {})
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(params[k] !== undefined ? params[k] : '')))
    .join('&');
  return `${base}/rest/${endpoint}.view?${auth}${query ? '&' + query : ''}`;
}

function mapSubsonicSong(entry) {
  return {
    id: entry.id,
    name: entry.title || '',
    artist: entry.artist || '',
    artists: [{ name: entry.artist || '' }],
    album: entry.album || '',
    cover: entry.coverArt ? subsonicCoverUrl(entry.coverArt) : '',
    duration: (Number(entry.duration) || 0) * 1000,
    bitrate: entry.bitRate || 0,
    format: entry.suffix || (entry.contentType ? entry.contentType.split('/').pop() : 'mp3'),
    year: entry.year || 0,
    track: entry.track || 0,
    discNumber: entry.discNumber || 0,
    size: entry.size || 0,
    genre: entry.genre || '',
    playable: true,
    fee: 0,
  };
}

function mapSubsonicAlbum(entry) {
  return {
    id: entry.id,
    name: entry.name || entry.title || '',
    artist: entry.artist || '',
    cover: entry.coverArt ? subsonicCoverUrl(entry.coverArt) : '',
    songCount: entry.songCount || 0,
    duration: (Number(entry.duration) || 0) * 1000,
    year: entry.year || 0,
    genre: entry.genre || '',
  };
}

function mapSubsonicPlaylist(entry) {
  return {
    id: entry.id,
    name: entry.name || '',
    cover: entry.coverArt ? subsonicCoverUrl(entry.coverArt) : '',
    trackCount: entry.songCount || 0,
    duration: (Number(entry.duration) || 0) * 1000,
    creator: entry.owner || '',
    comment: entry.comment || '',
  };
}

let currentCoverConfig = null;
function subsonicCoverUrl(coverArtId) {
  if (!coverArtId || !currentCoverConfig) return '';
  const base = normalizeBaseUrl(currentCoverConfig.baseUrl || '');
  const auth = cacheAuth(currentCoverConfig);
  return `${base}/rest/getCoverArt.view?${auth}&id=${encodeURIComponent(coverArtId)}`;
}

async function subsonicGet(config, endpoint, params) {
  currentCoverConfig = config;
  const url = subsonicUrl(config, endpoint, params);
  console.log('[Navidrome] request:', url);
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mineradio/1.1.0',
      'Accept': 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`Subsonic API ${endpoint} returned ${resp.status}`);
  }
  const body = await resp.json();
  const subsonic = body && body['subsonic-response'];
  if (!subsonic || subsonic.status !== 'ok') {
    const err = subsonic && subsonic.error;
    throw new Error(err ? (err.message || err.code || 'Subsonic error') : 'Subsonic error: unknown');
  }
  return subsonic;
}

async function testConnection(config) {
  try {
    console.log('[Navidrome] testing connection:', JSON.stringify({ baseUrl: config.baseUrl, username: config.username, hasPassword: !!config.password }));
    await subsonicGet(config, 'ping');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function search(config, keywords, limit) {
  limit = Math.max(5, Math.min(50, limit || 20));
  const result = await subsonicGet(config, 'search3', {
    query: keywords,
    songCount: limit,
    songOffset: 0,
    albumCount: 0,
    artistCount: 0,
  });
  const songs = (result.searchResult3 && result.searchResult3.song) || [];
  return (Array.isArray(songs) ? songs : [songs]).map(mapSubsonicSong);
}

async function songUrl(config, song, quality) {
  const id = song && (song.id || song.songId);
  if (!id) return null;
  const base = normalizeBaseUrl(config.baseUrl || '');
  const auth = cacheAuth(config);
  const streamUrl = `${base}/rest/stream.view?${auth}&id=${encodeURIComponent(id)}`;
  return {
    url: streamUrl,
    playable: true,
    trial: false,
    level: 'lossless',
    quality: '原始',
  };
}

async function lyric(config, song) {
  if (!song || (!song.id && !song.artist)) return null;
  try {
    const result = await subsonicGet(config, 'getLyrics', {
      artist: song.artist || '',
      title: song.name || song.title || '',
    });
    const entry = result.lyrics;
    if (entry && entry.value) {
      return {
        lyric: entry.value,
        tlyric: '',
        source: 'navidrome',
      };
    }
  } catch (e) {
    // getLyrics 可能在未实现歌词功能的服务器上返回 404，这是可以接受的
  }
  // 尝试 getLyricsBySongId (OpenSubsonic)
  if (song.id) {
    try {
      const result = await subsonicGet(config, 'getLyricsBySongId', { id: song.id });
      const entry = result.lyrics;
      if (entry && entry.value) {
        return { lyric: entry.value, tlyric: '', source: 'navidrome' };
      }
    } catch (e2) {}
  }
  return null;
}

async function getPlaylists(config) {
  try {
    const result = await subsonicGet(config, 'getPlaylists');
    const raw = result.playlists && result.playlists.playlist;
    return (Array.isArray(raw) ? raw : (raw ? [raw] : [])).map(mapSubsonicPlaylist);
  } catch (e) {
    console.warn('[Navidrome] playlists failed:', e.message);
    return [];
  }
}

async function getPlaylistTracks(config, playlistId) {
  const result = await subsonicGet(config, 'getPlaylist', { id: playlistId });
  const entry = result.playlist && result.playlist.entry;
  return (Array.isArray(entry) ? entry : (entry ? [entry] : [])).map(mapSubsonicSong);
}

async function getAlbumList(config, type, size, offset) {
  const result = await subsonicGet(config, 'getAlbumList2', {
    type: type || 'newest',
    size: size || 20,
    offset: offset || 0,
  });
  const raw = result.albumList2 && result.albumList2.album;
  return (Array.isArray(raw) ? raw : (raw ? [raw] : [])).map(mapSubsonicAlbum);
}

async function getAlbumTracks(config, albumId) {
  const result = await subsonicGet(config, 'getAlbum', { id: albumId });
  const entry = result.album && result.album.song;
  return (Array.isArray(entry) ? entry : (entry ? [entry] : [])).map(mapSubsonicSong);
}

async function getArtistList(config) {
  const result = await subsonicGet(config, 'getArtists');
  const raw = result.artists && result.artists.index;
  const artists = [];
  if (Array.isArray(raw)) {
    raw.forEach(idx => {
      const list = idx.artist || [];
      (Array.isArray(list) ? list : [list]).forEach(a => {
        artists.push({
          id: a.id,
          name: a.name || '',
          cover: a.coverArt ? subsonicCoverUrl(a.coverArt) : '',
          albumCount: a.albumCount || 0,
        });
      });
    });
  }
  return artists;
}

async function getArtistSongs(config, artistId) {
  // getArtist 返回艺术家的信息和热门曲目
  const result = await subsonicGet(config, 'getArtist', { id: artistId });
  const entry = result.artist && result.artist.album;
  if (!entry) return [];
  const albums = Array.isArray(entry) ? entry : [entry];
  const allSongs = [];
  for (const album of albums.slice(0, 3)) {
    try {
      const tracks = await getAlbumTracks(config, album.id);
      tracks.forEach(t => {
        if (!allSongs.find(s => s.id === t.id)) allSongs.push(t);
      });
    } catch (e) {}
  }
  return allSongs.slice(0, 50);
}

async function getRandomSongs(config, size) {
  const result = await subsonicGet(config, 'getRandomSongs', {
    size: size || 20,
  });
  const raw = result.randomSongs && result.randomSongs.song;
  return (Array.isArray(raw) ? raw : (raw ? [raw] : [])).map(mapSubsonicSong);
}

async function getStarred(config) {
  const result = await subsonicGet(config, 'getStarred2');
  const songRaw = result.starred2 && result.starred2.song;
  const albumRaw = result.starred2 && result.starred2.album;
  const songs = (Array.isArray(songRaw) ? songRaw : (songRaw ? [songRaw] : [])).map(mapSubsonicSong);
  const albums = (Array.isArray(albumRaw) ? albumRaw : (albumRaw ? [albumRaw] : [])).map(mapSubsonicAlbum);
  return { songs, albums };
}

async function starItem(config, id, type) {
  await subsonicGet(config, type === 'album' ? 'star' : 'star', {
    id,
    albumId: type === 'album' ? id : undefined,
  });
  return { ok: true };
}

async function unstarItem(config, id, type) {
  await subsonicGet(config, type === 'album' ? 'unstar' : 'unstar', {
    id,
    albumId: type === 'album' ? id : undefined,
  });
  return { ok: true };
}

// ====================================================================
//  Navidrome 适配器导出
// ====================================================================
const adapter = {
  id: 'navidrome',
  name: 'Navidrome',
  type: 'navidrome',

  // 连接测试
  testConnection,

  // 核心播放接口
  search: async function(keywords, limit, config) {
    return search(config, keywords, limit);
  },

  songUrl: async function(song, quality, config) {
    return songUrl(config, song, quality);
  },

  lyric: async function(song, config) {
    return lyric(config, song);
  },

  // 歌单
  playlists: async function(config) {
    return getPlaylists(config);
  },

  playlistTracks: async function(playlistId, config) {
    return getPlaylistTracks(config, playlistId);
  },

  // 专辑
  getAlbumList: async function(type, size, offset, config) {
    return getAlbumList(config, type, size, offset);
  },

  getAlbumTracks: async function(albumId, config) {
    return getAlbumTracks(config, albumId);
  },

  // 艺术家
  getArtists: async function(config) {
    return getArtistList(config);
  },

  getArtistSongs: async function(artistId, config) {
    return getArtistSongs(config, artistId);
  },

  // 随机/收藏
  getRandomSongs: async function(size, config) {
    return getRandomSongs(config, size);
  },

  getStarred: async function(config) {
    return getStarred(config);
  },

  star: async function(id, type, config) {
    return starItem(config, id, type);
  },

  unstar: async function(id, type, config) {
    return unstarItem(config, id, type);
  },

  // 登录态
  login: async function(config) {
    const result = await testConnection(config);
    return { ...result, loggedIn: result.ok, config };
  },

  loginStatus: async function(config) {
    try {
      await subsonicGet(config, 'ping');
      return { loggedIn: true };
    } catch (e) {
      return { loggedIn: false };
    }
  },
};

module.exports = adapter;
