/* OpenVibe.Meme: what the pages are complete without. On /make the preview follows the template and the lines as you
 * type (the Preview button still works without JavaScript); a template card shows which one is chosen. */
(function () {
    'use strict';
    function maker() {
        var form = document.getElementById('mm-caption-form');
        var aside = document.getElementById('mm-preview');
        if (!form || !aside || form.dataset.ready) return;
        form.dataset.ready = '1';
        var fig = aside.querySelector('.mm-caption-card');
        if (!fig) {
            aside.querySelectorAll('.mm-muted').forEach(function (p) { p.remove(); });
            fig = document.createElement('figure'); fig.className = 'mm-caption-card';
            fig.appendChild(document.createElement('img')); fig.appendChild(document.createElement('figcaption'));
            aside.appendChild(fig);
        }
        var img = fig.querySelector('img'), cap = fig.querySelector('figcaption');
        img.alt = '';
        function draw() {
            var chosen = form.querySelector('input[name=template_id]:checked');
            form.querySelectorAll('.mm-template').forEach(function (l) { l.classList.toggle('is-chosen', !!l.querySelector('input:checked')); });
            if (chosen) { var t = chosen.closest('.mm-template').querySelector('img'); if (t && img.src !== t.src) img.src = t.src; }
            cap.replaceChildren();
            for (var i = 1; i <= 4; i++) {
                var input = form.querySelector('[name=line' + i + ']');
                var span = document.createElement('span');
                span.textContent = input ? input.value : '';
                cap.appendChild(span);
            }
        }
        form.addEventListener('input', draw);
        form.addEventListener('change', draw);
        draw();
    }
    function run() { maker(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
