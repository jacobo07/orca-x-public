// In-WebView find-in-scrollback, injected into XTERM_HTML. Closes over term / notify
// defined in the host IIFE; window.SearchAddon comes from the bundled engine.
export const TERMINAL_SEARCH_JS = `
  var searchAddon = null;
  var searchAddonTerm = null;
  var lastSearchQuery = null;
  // Same contrast desktop uses (TerminalSearch.tsx); xterm requires #RRGGBB.
  var SEARCH_OPTIONS = {
    decorations: {
      matchBackground: '#5c4a00',
      matchBorder: '#5c4a00',
      matchOverviewRuler: '#ffcc00',
      activeMatchBackground: '#c4580e',
      activeMatchBorder: '#ffcf6b',
      activeMatchColorOverviewRuler: '#ff9900'
    }
  };

  function searchLog(step, err) {
    notify({ type: 'log', tag: '[search]', payload: { step: step, error: String(err && err.message || err) } });
  }

  function notifySearchResults(resultIndex, resultCount) {
    notify({ type: 'search-results', resultIndex: resultIndex, resultCount: resultCount });
  }

  // A re-init builds a new Terminal, so the addon follows the current one.
  function ensureSearchAddon() {
    if (!term || !window.SearchAddon || !window.SearchAddon.SearchAddon) return null;
    if (searchAddonTerm === term && searchAddon) return searchAddon;
    try {
      var addon = new window.SearchAddon.SearchAddon();
      term.loadAddon(addon);
      addon.onDidChangeResults(function(r) { notifySearchResults(r.resultIndex, r.resultCount); });
      searchAddon = addon;
      searchAddonTerm = term;
      lastSearchQuery = null;
      return addon;
    } catch (e) {
      searchLog('load-addon', e);
      searchAddon = null;
      searchAddonTerm = null;
      return null;
    }
  }

  // Why: this xterm build can leave a disposed match painted forever (STA-2707; desktop
  // patches xterm for it). Nothing else here registers decorations, so a reset is safe.
  function clearSearchDecorations(addon) {
    try { addon.clearDecorations(); } catch (e) { searchLog('clear-decorations', e); }
    var service = term && term._core && term._core._decorationService;
    if (service && typeof service.reset === 'function') {
      try { service.reset(); } catch (e) { searchLog('reset-decorations', e); }
    }
  }

  function clearTermSelection() {
    if (!term) return;
    try { term.clearSelection(); } catch (e) { searchLog('clear-selection', e); }
  }

  function runSearch(query, direction) {
    var addon = ensureSearchAddon();
    if (!addon) { notifySearchResults(-1, 0); return; }
    // Why: clearing resets the addon's position, so only a new query starts over.
    if (query !== lastSearchQuery) {
      clearSearchDecorations(addon);
      lastSearchQuery = query;
    }
    if (typeof query !== 'string' || query.length === 0) {
      clearTermSelection();
      notifySearchResults(-1, 0);
      return;
    }
    var found = false;
    try {
      found = direction === 'previous'
        ? addon.findPrevious(query, SEARCH_OPTIONS)
        : addon.findNext(query, SEARCH_OPTIONS);
    } catch (e) {
      searchLog('find', e);
    }
    if (!found) notifySearchResults(-1, 0);
  }

  function clearSearch() {
    if (searchAddon && searchAddonTerm === term) clearSearchDecorations(searchAddon);
    lastSearchQuery = null;
    clearTermSelection();
  }
`
