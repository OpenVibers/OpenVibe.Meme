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
        var filter = document.getElementById('mm-template-filter');
        if (filter) filter.addEventListener('input', function () {
            var query = filter.value.trim().toLocaleLowerCase();
            form.querySelectorAll('.mm-template').forEach(function (card) {
                card.hidden = query && !card.textContent.toLocaleLowerCase().includes(query);
            });
        });
        var download = aside.querySelector('[data-render-png]');
        var status = aside.querySelector('[data-render-status]');
        if (download) download.addEventListener('click', async function () {
            var chosen = form.querySelector('input[name=template_id]:checked');
            if (!chosen) { status.textContent = 'Choose a template first.'; return; }
            download.disabled = true;
            status.textContent = 'Rendering your PNG…';
            try {
                var lines = [];
                for (var i = 1; i <= 4; i++) {
                    var input = form.querySelector('[name=line' + i + ']');
                    if (input && input.value.trim()) lines.push(input.value.trim());
                }
                if (!lines.length) throw new Error('Add a caption before exporting.');
                var response = await fetch('/api/v1/render', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'image/png' },
                    body: JSON.stringify({ template_id: chosen.value, lines: lines })
                });
                if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to export a PNG.' : 'Could not render this caption. Try again.');
                var url = URL.createObjectURL(await response.blob());
                var link = document.createElement('a');
                link.href = url; link.download = 'openvibe-meme.png'; link.click();
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
                status.textContent = 'PNG downloaded.';
            } catch (error) { status.textContent = error && error.message ? error.message : 'Could not render this caption.'; }
            finally { download.disabled = false; }
        });
        draw();
    }
    function run() { maker(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
