/**
 * The language fetch results
 * @typedef {Object} MxMLanguages
 * @property {string} language_iso_code_1 - The 2 letter ISO-like code of the language.
 * @property {string} language_iso_code_3 - The 3 letter ISO-like code of the language.
 * @property {string} language_name - The full name of the language.
 */

/**
 * The crowd translation fetch results
 * @typedef {Object} MxMCrowdTranslation
 * @property {string} id - The track ID
 * @property {string} from - The source language name
 * @property {string} to - The target language name
 * @property {string} code - The 3 letter ISO-like code of the language.
 * @property {string} code1 - The 2 letter ISO-like code of the language.
 */

/**
 * The synced tracks content
 * @typedef {Object} MxMTrack
 * @property {number} startTime - The timing of the lyrics in miliseconds
 * @property {string} text - The text
 */

/**
 * The translation lyrics content
 * @typedef {Object} MxMTranslationLyricsContent
 * @property {number} startTime - The timing of the lyrics in miliseconds
 * @property {string} text - The translation/source if incomplete TL
 * @property {string} code - The 3 letter ISO-like code of the language.
 * @property {string} code1 - The 2 letter ISO-like code of the language.
 */

/**
 * The translation content
 * @typedef {Object} MxMTranslationContent
 * @property {string} id - The track ID
 * @property {string} from - The source language name
 * @property {string} to - The target language name
 * @property {string} code - The 3 letter ISO-like code of the language.
 * @property {MxMTranslationLyricsContent[]} translations - The lyrics contents
 */

const LANGUAGES_CACHE = {
	mxmLanguages: null
};

const ProviderMusixmatch = (function () {
	const headers = {
		authority: "apic-desktop.musixmatch.com",
		cookie: "x-mxm-token-guid="
	};

	async function _getMxMLanguages() {
		if (LANGUAGES_CACHE.mxmLanguages) {
			console.debug("Musixmatch languages cache hit");
			return LANGUAGES_CACHE.mxmLanguages;
		}
		// Request language list
		const baseURL = `https://apic-desktop.musixmatch.com/ws/1.1/languages.get?format=json&app_id=web-desktop-app-v1.0&`;

		const params = {
			get_romanized_info: 1,
			usertoken: CONFIG.providers.musixmatch.token
		};

		const finalURL =
			baseURL +
			Object.keys(params)
				.map(key => key + "=" + encodeURIComponent(params[key]))
				.join("&");

		const request = await CosmosAsync.get(finalURL, null, headers);

		if (request.message.header.status_code !== 200) {
			return [];
		}

		const languagesList = [];
		const bodyLanguageList = request.message.body.language_list;
		for (let i = 0; i < bodyLanguageList.length; i++) {
			languagesList.push(bodyLanguageList[i].language);
		}
		LANGUAGES_CACHE.mxmLanguages = languagesList;

		return languagesList;
	}

	async function findLyrics(info) {
		const baseURL = `https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?format=json&namespace=lyrics_richsynched&subtitle_format=mxm&app_id=web-desktop-app-v1.0&`;

		const durr = info.duration / 1000;

		const params = {
			q_album: info.album,
			q_artist: info.artist,
			q_artists: info.artist,
			q_track: info.title,
			track_spotify_id: info.uri,
			q_duration: durr,
			f_subtitle_length: Math.floor(durr),
			usertoken: CONFIG.providers.musixmatch.token,
			part: "track_lyrics_translation_status"
		};

		const finalURL =
			baseURL +
			Object.keys(params)
				.map(key => key + "=" + encodeURIComponent(params[key]))
				.join("&");

		let body = await CosmosAsync.get(finalURL, null, headers);

		body = body.message.body.macro_calls;

		if (body["matcher.track.get"].message.header.status_code !== 200) {
			return {
				error: `Requested error: ${body["matcher.track.get"].message.header.mode}`,
				uri: info.uri
			};
		} else if (body["track.lyrics.get"]?.message?.body?.lyrics?.restricted) {
			return {
				error: "Unfortunately we're not authorized to show these lyrics.",
				uri: info.uri
			};
		}

		return body;
	}

	async function getKaraoke(body) {
		const meta = body?.["matcher.track.get"]?.message?.body;
		if (!meta) {
			return null;
		}

		if (!meta.track.has_richsync || meta.track.instrumental) {
			return null;
		}

		const baseURL = `https://apic-desktop.musixmatch.com/ws/1.1/track.richsync.get?format=json&subtitle_format=mxm&app_id=web-desktop-app-v1.0&`;

		const params = {
			f_subtitle_length: meta.track.track_length,
			q_duration: meta.track.track_length,
			commontrack_id: meta.track.commontrack_id,
			usertoken: CONFIG.providers.musixmatch.token
		};

		const finalURL =
			baseURL +
			Object.keys(params)
				.map(key => key + "=" + encodeURIComponent(params[key]))
				.join("&");

		let result = await CosmosAsync.get(finalURL, null, headers);

		if (result.message.header.status_code != 200) {
			return null;
		}

		result = result.message.body;

		const parsedKaraoke = JSON.parse(result.richsync.richsync_body).map(line => {
			const startTime = line.ts * 1000;
			const endTime = line.te * 1000;
			const words = line.l;

			const text = words.map((word, index, words) => {
				const wordText = word.c;
				const wordStartTime = word.o * 1000;
				const nextWordStartTime = words[index + 1]?.o * 1000;

				const time = !isNaN(nextWordStartTime) ? nextWordStartTime - wordStartTime : endTime - (wordStartTime + startTime);

				return {
					word: wordText,
					time
				};
			});
			return {
				startTime,
				text
			};
		});

		return parsedKaraoke;
	}

	function getSynced(body) {
		const meta = body?.["matcher.track.get"]?.message?.body;
		if (!meta) {
			return null;
		}

		const hasSynced = meta?.track?.has_subtitles;

		const isInstrumental = meta?.track?.instrumental;

		if (isInstrumental) {
			return [{ text: "♪ Instrumental ♪", startTime: "0000" }];
		} else if (hasSynced) {
			const subtitle = body["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle;
			if (!subtitle) {
				return null;
			}

			return JSON.parse(subtitle.subtitle_body).map(line => ({
				text: line.text || "♪",
				startTime: line.time.total * 1000
			}));
		}

		return null;
	}

	function getUnsynced(body) {
		const meta = body?.["matcher.track.get"]?.message?.body;
		if (!meta) {
			return null;
		}

		const hasUnSynced = meta.track.has_lyrics || meta.track.has_lyrics_crowd;

		const isInstrumental = meta?.track?.instrumental;

		if (isInstrumental) {
			return [{ text: "♪ Instrumental ♪" }];
		} else if (hasUnSynced) {
			const lyrics = body["track.lyrics.get"]?.message?.body?.lyrics?.lyrics_body;
			if (!lyrics) {
				return null;
			}
			return lyrics.split("\n").map(text => ({ text }));
		}

		return null;
	}

	async function getCrowdTranslation(body) {
		const meta = body?.["matcher.track.get"]?.message?.body;
		if (!meta) {
			return null;
		}

		const translationsStatus = meta?.track?.track_lyrics_translation_status ?? [];
		if (!translationsStatus) {
			return null;
		}

		const completeTL = translationsStatus.filter(tl => tl.perc >= 1);
		if (completeTL.length <= 0) {
			return null;
		}

		const languages = await _getMxMLanguages();
		if (!languages) {
			console.debug("Failed to get languages data, even if translation exist!", meta);
			return null;
		}

		const results = [];
		for (let i = 0; i < completeTL.length; i++) {
			const crowdTL = completeTL[i];
			const tlCode1 = languages.find(l => l.language_iso_code_3 === crowdTL.to);
			if (tlCode1 === undefined) {
				console.debug("Failed to find language code", crowdTL);
				continue;
			}
			const tlCodeSource = languages.find(l => l.language_iso_code_3 === crowdTL.from);

			results.push({
				id: meta.track.commontrack_id,
				from: tlCodeSource?.language_name ?? crowdTL.from,
				to: tlCode1.language_name,
				code: tlCode1.language_iso_code_3,
				code1: tlCode1.language_iso_code_1
			});
		}

		return results;
	}

	/**
	 *
	 * @param {MxMCrowdTranslation} language The language to fetch
	 * @param {MxMTrack} syncedTracks The synced tracks
	 * @returns
	 */
	async function fetchTranslationsForLanguage(language, syncedTracks) {
		const params = {
			page: 1,
			page_size: 100,
			commontrack_id: language.id,
			selected_language: language.code1,
			usertoken: CONFIG.providers.musixmatch.token
		};

		const baseURL = `https://apic-desktop.musixmatch.com/ws/1.1/crowd.track.translations.get?app_id=web-desktop-app-v1.0&`;

		const finalURL =
			baseURL +
			Object.keys(params)
				.map(key => key + "=" + encodeURIComponent(params[key]))
				.join("&");

		const request = await CosmosAsync.get(finalURL, null, headers);
		const translationBody = request?.message?.body?.translations_list ?? [];
		if (!translationBody) {
			console.debug("Failed to get translation body", language);
			return;
		}

		const translationsParts = [];
		for (let j = 0; j < syncedTracks.length; j++) {
			const match =
				translationBody.find(t => t.translation.subtitle_matched_line === syncedTracks[j].text) ??
				translationBody.find(t => t.translation.matched_line === syncedTracks[j].text) ??
				translationBody.find(t => t.translation.snippet === syncedTracks[j].text);
			if (match === undefined) {
				translationsParts.push(syncedTracks[j]);
			} else {
				translationsParts.push({
					startTime: syncedTracks[j].startTime,
					text: match.translation.description
				});
			}
		}

		return {
			id: language.id,
			from: language.from,
			to: language.to,
			code: language.code,
			translations: translationsParts
		};
	}

	return { findLyrics, getKaraoke, getSynced, getUnsynced, getCrowdTranslation, fetchTranslationsForLanguage };
})();
