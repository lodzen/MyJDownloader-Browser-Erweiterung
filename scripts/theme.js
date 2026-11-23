(function () {
    var KEY = 'MYJD_THEME';
    var docEl = document.documentElement;

    function apply(theme) {
        docEl.setAttribute('data-theme', theme);
        try {
            localStorage.setItem(KEY, theme);
        } catch (e) {
        }
        try {
            chrome.storage.local.set({MYJD_THEME: theme});
        } catch (e) {
        }
    }

    window.myjdTheme = {
        get: function () {
            return docEl.getAttribute('data-theme') || 'auto';
        },
        effective: function () {
            var t = docEl.getAttribute('data-theme');
            if (t === 'dark' || t === 'light') {
                return t;
            }
            return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
        },
        toggle: function () {
            apply(this.effective() === 'dark' ? 'light' : 'dark');
            return docEl.getAttribute('data-theme');
        }
    };

    try {
        var cached = localStorage.getItem(KEY);
        if (cached) {
            docEl.setAttribute('data-theme', cached);
        }
    } catch (e) {
    }
    try {
        chrome.storage.local.get(KEY, function (result) {
            var t = result && result[KEY];
            if (t) {
                docEl.setAttribute('data-theme', t);
            }
        });
    } catch (e) {
    }
})();
