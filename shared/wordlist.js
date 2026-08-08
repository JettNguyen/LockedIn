// shared/wordlist.js
//
// Lazily-loaded English word lists, shared by any game that needs to know
// whether a string is a real word (Wend) or to guess which real word a player
// is reaching for (CrossClimb).
//
// Two lists, because they answer different questions:
//
//   words.txt         ~359k entries: Webster's Second (/usr/share/dict/words,
//                     1934 copyright lapsed) merged with dwyl/english-words and
//                     the frequency list below. Exhaustive to the point of
//                     absurdity - it will happily tell you "aalii" is a word -
//                     which is right for *validating* something the board
//                     already implies and wrong for guessing.
//
//                     Webster's alone was not enough, and the failure was
//                     invisible: a Wend board whose answer was JOYSTICK simply
//                     reported that it couldn't be read, because a 1934
//                     dictionary has no joysticks. Anything modern - EMAIL,
//                     BLOG - failed the same silent way, so the list has to
//                     cover present-day English, not just a lot of English.
//
//   common-words.txt  The ~9.4k most frequent English words. Puzzle answers are
//                     drawn from words people actually use, so searching this
//                     first both finds the intended answer and keeps the search
//                     from drowning in obscurities. Measured on random 5-word
//                     ladders: restricting to common words takes the average
//                     number of one-letter neighbours per word from 7.5 to 4.3,
//                     which is the difference between a missing rung being
//                     pinned down and being one of a dozen possibilities.
//
// Both are fetched once per page and cached. A failed load resolves to null
// rather than throwing - every caller treats a missing list as "skip whatever
// that list was for" so the extension degrades instead of breaking.

window.LockedInWords = (function () {
  const cache = new Map(); // path → Promise<Set<string>|null>

  function loadList(path) {
    if (cache.has(path)) return cache.get(path);
    const promise = (async () => {
      try {
        const res = await fetch(chrome.runtime.getURL(path));
        if (!res.ok) return null;
        const set = new Set();
        for (const line of (await res.text()).split('\n')) {
          if (line) set.add(line);
        }
        return set.size ? set : null;
      } catch (_) {
        return null;
      }
    })();
    cache.set(path, promise);
    return promise;
  }

  const all = () => loadList('shared/words.txt');
  const common = () => loadList('shared/common-words.txt');

  // Words of exactly `length`, lowercased, from whichever list is asked for.
  async function ofLength(length, { commonOnly = false } = {}) {
    const set = await (commonOnly ? common() : all());
    if (!set) return null;
    const out = [];
    for (const w of set) if (w.length === length) out.push(w);
    return out;
  }

  return { all, common, ofLength };
})();
