/**
 * Mineradio LX Music 音源模板
 * ============================
 * 这是一个可用的 LX Music 格式音源骨架。
 * 使用时放到 sources/ 目录，更新 sources.json 中的 sources 数组。
 *
 * LX Music 音源通常导出一个对象：
 *   module.exports = { getMusicSources, ... }
 *
 * Mineradio 兼容的子集：
 *   - getMusicSources()  → 返回音源列表，每个包含搜索结果
 *   - 可选的 getLyric() / getMusicUrl() / getUserPlaylists()
 *
 * Mineradio 的 createLXMusicAdapter() 会包装这个模块为统一接口。
 */

module.exports = {
  // 音源元信息
  name: '示例音源',
  version: '1.0.0',
  author: 'Your Name',

  /**
   * getMusicSources() 返回一个音源组数组。
   * 每个组可能包含多个子源 (sources)。
   * Mineradio 会遍历所有组/子源收集歌曲。
   *
   * @returns {Array<{name: string, sources: Array<{name: string, songs: Array}>}>}
   */
  getMusicSources() {
    // 这是一个静态示例。实际音源通常通过网络请求获取。
    return [
      {
        name: '示例电台',
        sources: [
          {
            name: '推荐',
            songs: [
              {
                name: '歌曲名称',
                singer: '歌手',
                album: '专辑',
                duration: 240,      // 秒
                coverUrl: 'https://example.com/cover.jpg',
                songUrl: 'https://example.com/stream.mp3',
                lyricUrl: 'https://example.com/lyric.lrc',
                bitrate: 320,       // kbps
                format: 'mp3',
              },
            ],
          },
        ],
      },
    ];
  },

  /**
   * getMusicUrl(song) — 获取歌曲播放地址（实时）
   * @param {object} song - 歌曲对象 { id, name, artist, ... }
   * @returns {Promise<string>} 直接音频 URL
   */
  async getMusicUrl(song) {
    // 如果 song 已经包含 url，直接返回
    if (song && song.songUrl) return song.songUrl;
    // TODO: 通过网络请求获取音频地址
    return null;
  },

  /**
   * getLyric(song) — 获取歌词
   * @param {object} song - 歌曲对象
   * @returns {Promise<string>} LRC 格式歌词文本
   */
  async getLyric(song) {
    // 如果 song 已经包含 lyricUrl，可以直接 fetch
    if (song && song.lyricUrl) {
      const resp = await fetch(song.lyricUrl);
      return resp.text();
    }
    // TODO: 通过网络请求获取歌词
    return null;
  },

  /**
   * getPlaylistDetail(id, config) — 获取歌单详细曲目
   * @param {string} id - 歌单 ID
   * @param {object} config - 音源配置
   * @returns {Promise<Array>} 歌曲列表
   */
  async getPlaylistDetail(id, config) {
    // TODO: 通过网络请求获取歌单内歌曲
    return [];
  },

  /**
   * getUserPlaylists(config) — 获取用户歌单
   * @param {object} config - 音源配置
   * @returns {Promise<Array>} 歌单列表
   */
  async getUserPlaylists(config) {
    // TODO: 通过网络请求获取用户歌单列表
    return [];
  },
};
