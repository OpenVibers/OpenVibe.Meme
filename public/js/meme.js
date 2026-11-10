/* OpenVibe.Meme: what the pages are complete without. On /make the preview follows the template and the lines as you
 * type (the Preview button still works without JavaScript); a template card shows which one is chosen. */
(function () {
    'use strict';
    function maker() {
        var form = document.getElementById('mm-caption-form');
        var aside = document.getElementById('mm-preview');
        if (!form || !aside || form.dataset.ready) return;
        form.dataset.ready = '1';
        var stage = aside.querySelector('[data-stage]'), canvasImg = stage && stage.querySelector('[data-canvas-image]');
        var boxLayer = stage && stage.querySelector('[data-caption-boxes]'), stickers = stage && stage.querySelector('[data-stickers]');
        var editorStatus = aside.querySelector('[data-editor-status]');
        var boxPositions = [[5, 7, 90, 24], [5, 68, 90, 24], [5, 37, 90, 20], [5, 43, 90, 18]];
        var stickerList = [];
        var activeTemplate = null;
        function field(name) { return form.querySelector('[name=' + name + ']'); }
        function draw() {
            var chosen = form.querySelector('input[name=template_id]:checked');
            form.querySelectorAll('.mm-template').forEach(function (l) { l.classList.toggle('is-chosen', !!l.querySelector('input:checked')); });
            drawCanvas(chosen);
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
        function drawCanvas(chosen) {
            var selected = chosen || form.querySelector('input[name=template_id]:checked');
            if (selected) {
                var card = selected.closest('.mm-template'), picture = card && card.querySelector('img');
                if (picture && canvasImg && canvasImg.src !== picture.src) canvasImg.src = picture.src;
                if (card && activeTemplate !== selected.value) {
                    activeTemplate = selected.value;
                    try {
                        var layout = JSON.parse(card.dataset.layout || '{}'), source = Array.isArray(layout.boxes) ? layout.boxes : [], w = Number(layout.width) || 440, h = Number(layout.height) || 280;
                        var count = Math.max(1, Math.min(4, Number(card && card.dataset.boxes) || 4));
                        if (source.length) boxPositions = source.slice(0, 4).map(function (b) { return [Number(b.x) / w * 100, Number(b.y) / h * 100, Number(b.w) / w * 100, Number(b.h) / h * 100]; });
                        else boxPositions = [[5, 7, 90, 24], [5, 68, 90, 24], [5, 37, 90, 20], [5, 43, 90, 18]].slice(0, count);
                    } catch (_) { /* Keep the editor's default positions for malformed optional layout data. */ }
                }
            }
            var font = field('font_style') && field('font_style').value || 'impact';
            var size = Number(field('font_size') && field('font_size').value || 30);
            var color = field('text_color') && field('text_color').value || '#fff';
            var outline = field('outline_color') && field('outline_color').value || '#000';
            var width = Number(field('outline_width') && field('outline_width').value || 0);
            var cropX = Number(field('crop_x') && field('crop_x').value || 50), cropY = Number(field('crop_y') && field('crop_y').value || 50);
            if (canvasImg) canvasImg.style.objectPosition = cropX + '% ' + cropY + '%';
            for (var n = 1; n <= 4; n++) { var lineField = field('line' + n); var lineLabel = lineField && lineField.closest('.mm-field'); if (lineLabel) lineLabel.hidden = n > boxPositions.length; }
            if (boxLayer) {
                boxLayer.replaceChildren();
                for (var i = 1; i <= boxPositions.length; i++) {
                    var input = field('line' + i), box = document.createElement('div');
                    box.className = 'mm-editor-box mm-font-' + font; box.dataset.box = String(i - 1);
                    var pos = boxPositions[i - 1]; box.style.left = pos[0] + '%'; box.style.top = pos[1] + '%'; box.style.width = pos[2] + '%'; box.style.height = pos[3] + '%';
                    box.style.fontSize = 'clamp(12px, ' + (size / 5) + 'vw, ' + size + 'px)'; box.style.color = color;
                    box.style.webkitTextStroke = width + 'px ' + outline; box.textContent = input ? input.value : '';
                    var handle = document.createElement('i'); handle.className = 'mm-resize-handle'; handle.setAttribute('aria-hidden', 'true'); box.appendChild(handle); boxLayer.appendChild(box);
                }
            }
            if (stickers) { stickers.replaceChildren(); stickerList.forEach(function (s, i) { var n = document.createElement('span'); n.className = 'mm-editor-sticker'; n.textContent = s.emoji; n.style.left = s.x + '%'; n.style.top = s.y + '%'; n.dataset.sticker = String(i); stickers.appendChild(n); }); }
            var state = field('editor_state');
            if (state) state.value = JSON.stringify({ boxes: boxPositions.map(function (p) { return { x: p[0], y: p[1], w: p[2], h: p[3] }; }), stickers: stickerList, font_style: font, font_size: size, color: color, outline: outline, outline_width: width, crop_x: cropX, crop_y: cropY });
        }
        if (stage) {
            var drag = null;
            stage.addEventListener('pointerdown', function (event) {
                var box = event.target.closest('.mm-editor-box'); if (!box) return;
                var pos = boxPositions[Number(box.dataset.box)]; drag = { id: event.pointerId, box: Number(box.dataset.box), x: event.clientX, y: event.clientY, pos: pos.slice(), resize: event.target.classList.contains('mm-resize-handle'), rect: stage.getBoundingClientRect() };
                stage.setPointerCapture(event.pointerId); event.preventDefault();
            });
            stage.addEventListener('pointermove', function (event) {
                if (!drag || drag.id !== event.pointerId) return;
                var dx = (event.clientX - drag.x) / drag.rect.width * 100, dy = (event.clientY - drag.y) / drag.rect.height * 100, p = drag.pos;
                if (drag.resize) { p[2] = Math.max(15, Math.min(98 - p[0], p[2] + dx)); p[3] = Math.max(8, Math.min(98 - p[1], p[3] + dy)); }
                else { p[0] = Math.max(0, Math.min(95, p[0] + dx)); p[1] = Math.max(0, Math.min(95, p[1] + dy)); }
                boxPositions[drag.box] = p;
                var active = boxLayer.querySelector('[data-box="' + drag.box + '"]');
                if (active) { active.style.left = p[0] + '%'; active.style.top = p[1] + '%'; active.style.width = p[2] + '%'; active.style.height = p[3] + '%'; }
            });
            stage.addEventListener('pointerup', function () { drag = null; drawCanvas(); });
            stage.addEventListener('pointercancel', function () { drag = null; drawCanvas(); });
        }
        var addSticker = form.querySelector('[data-add-sticker]');
        if (addSticker) addSticker.addEventListener('click', function () { stickerList.push({ emoji: ['✨','😂','🔥','💀','👀'][stickerList.length % 5], x: 42 + stickerList.length * 4, y: 48 }); drawCanvas(); });
        var ideaButton = form.querySelector('[data-caption-ideas]'), ideaStatus = form.querySelector('[data-ai-status]');
        if (ideaButton) ideaButton.addEventListener('click', async function () {
            var topic = field('idea_topic').value.trim(), selected = form.querySelector('input[name=template_id]:checked');
            if (!topic || !selected) { ideaStatus.textContent = 'Choose a format and enter a topic first.'; return; }
            ideaButton.disabled = true; ideaStatus.textContent = 'Thinking up a few options…';
            try {
                var response = await fetch('/api/v1/caption-ideas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template_id: selected.value, topic: topic }) });
                var result = await response.json(); if (!response.ok) throw new Error(result.detail || 'Could not get caption ideas.');
                var list = form.querySelector('[data-idea-list]'); if (!list) { list = document.createElement('div'); list.dataset.ideaList = '1'; list.className = 'mm-ai-ideas'; ideaButton.parentNode.appendChild(list); }
                list.replaceChildren();
                result.ideas.forEach(function (idea) {
                    var use = document.createElement('button'); use.type = 'button'; use.className = 'mm-btn mm-btn-quiet'; use.textContent = idea.join(' / ');
                    use.addEventListener('click', function () { for (var i = 1; i <= 4; i++) { var input = field('line' + i); if (input) input.value = idea[i - 1] || ''; } draw(); field('line1').focus(); });
                    list.appendChild(use);
                });
                ideaStatus.textContent = 'Choose an idea to put it on your canvas.';
            } catch (error) { ideaStatus.textContent = error.message || 'Could not get caption ideas.'; }
            finally { ideaButton.disabled = false; }
        });
        // A member template: the shared picker and progress meter, then the same Media-backed review endpoint.
        var upload = document.querySelector('[data-template-upload]');
        if (upload && window.OVUpload) {
            var uploadStatus = document.querySelector('[data-template-upload-status]');
            var uploadMeter = document.createElement('div');
            uploadMeter.hidden = true;
            upload.after(uploadMeter);
            var lastUpload = null;
            function sayUpload(text, bad) { if (uploadStatus) { uploadStatus.textContent = text; uploadStatus.className = 'mm-fine' + (bad ? ' is-bad' : ''); } }
            var meter = window.OVUpload.progress(uploadMeter, { onRetry: function () { if (lastUpload) sendTemplate(lastUpload.file, lastUpload.row); } });
            function sendTemplate(file, row) {
                if (file.size > 6 * 1024 * 1024) { sayUpload('Choose an image under 6 MB.', true); return; }
                lastUpload = { file: file, row: row };
                uploadMeter.hidden = false;
                meter.update({ state: 'processing', done: 0, total: file.size, message: 'Preparing your image' });
                sayUpload('Preparing your image…');
                var reader = new FileReader();
                reader.onerror = function () { meter.update({ state: 'failed', message: 'That image could not be read.' }); sayUpload('That image could not be read.', true); };
                reader.onload = function () {
                    var data = String(reader.result || '');
                    var payload = JSON.stringify({ name: file.name.replace(/\.[^.]+$/, '').slice(0, 80), image: data });
                    meter.update({ state: 'sending', done: 0, total: payload.length });
                    sayUpload('Uploading for review…');
                    var xhr = new XMLHttpRequest();
                    xhr.open('POST', '/api/v1/templates/uploads');
                    xhr.setRequestHeader('Content-Type', 'application/json');
                    xhr.withCredentials = true;
                    xhr.upload.onprogress = function (e) { if (e.lengthComputable) meter.update({ state: 'sending', done: e.loaded, total: e.total }); };
                    xhr.onload = function () {
                        var body = null; try { body = JSON.parse(xhr.responseText || 'null'); } catch (_) { body = null; }
                        if (xhr.status >= 200 && xhr.status < 300) {
                            meter.update({ state: 'done', done: payload.length, total: payload.length, message: 'In the review queue' });
                            sayUpload('Submitted for review. You can keep making this meme while it is checked.');
                            if (row) { row.dispatchEvent(new Event('remove')); row.remove(); }
                            lastUpload = null;
                            return;
                        }
                        var detail = (body && (body.detail || body.error)) || 'Upload could not be submitted.';
                        meter.update({ state: 'failed', message: detail }); sayUpload(detail, true);
                    };
                    xhr.onerror = function () { meter.update({ state: 'failed', message: 'The connection dropped. Try again.' }); sayUpload('The connection dropped. Try again.', true); };
                    xhr.send(payload);
                };
                reader.readAsDataURL(file);
            }
            window.OVUpload.picker(upload, { label: 'Choose a template image', accept: 'image/png,image/jpeg,image/webp', onFile: sendTemplate });
        }
        var download = aside.querySelector('[data-render-png]');
        var status = aside.querySelector('[data-render-status]');
        if (download) download.addEventListener('click', async function () {
            var chosen = form.querySelector('input[name=template_id]:checked');
            if (!chosen) { status.textContent = 'Choose a template first.'; return; }
            download.disabled = true;
            status.textContent = 'Rendering your PNG…';
            try {
                var lines = [];
                for (var i = 1; i <= boxPositions.length; i++) {
                    var input = form.querySelector('[name=line' + i + ']');
                    if (input && input.value.trim()) lines.push(input.value.trim());
                }
                if (!lines.length) throw new Error('Add a caption before exporting.');
                var format = aside.querySelector('[data-export-format]') && aside.querySelector('[data-export-format]').value || 'png';
                var response = await fetch('/api/v1/render', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'image/png' },
                    body: JSON.stringify({ template_id: chosen.value, lines: lines, format: format, editor: { boxes: boxPositions.map(function (p) { return { x: p[0], y: p[1], w: p[2], h: p[3] }; }), stickers: stickerList, font_style: field('font_style').value, font_size: Number(field('font_size').value), color: field('text_color').value, outline: field('outline_color').value, outline_width: Number(field('outline_width').value), crop_x: Number(field('crop_x').value), crop_y: Number(field('crop_y').value) } })
                });
                if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to export a PNG.' : 'Could not render this caption. Try again.');
                var url = URL.createObjectURL(await response.blob());
                var link = document.createElement('a');
                link.href = url; link.download = 'openvibe-meme.' + format; link.click();
                setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
                status.textContent = 'PNG downloaded.';
            } catch (error) { status.textContent = error && error.message ? error.message : 'Could not render this caption.'; }
            finally { download.disabled = false; }
        });
        draw();
    }
    function shareTools() {
        document.querySelectorAll('[data-copy-link]').forEach(function (button) {
            if (button.dataset.ready) return; button.dataset.ready = '1';
            button.addEventListener('click', async function () {
                try { await navigator.clipboard.writeText(button.dataset.copyLink); button.textContent = 'Link copied'; }
                catch (_) { button.textContent = button.dataset.copyLink; }
            });
        });
        document.querySelectorAll('[data-native-share]').forEach(function (button) {
            if (button.dataset.ready) return; button.dataset.ready = '1';
            button.addEventListener('click', async function () {
                var data = { title: button.dataset.shareTitle || 'My meme', text: button.dataset.shareText || '', url: button.dataset.nativeShare };
                try { if (navigator.share) await navigator.share(data); else if (navigator.clipboard) { await navigator.clipboard.writeText(data.text + ' ' + data.url); button.textContent = 'Link copied'; } }
                catch (_) { /* The person closed the share sheet. */ }
            });
        });
    }
    function run() { maker(); shareTools(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
