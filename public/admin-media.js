import { optimizedImage } from './product-images.js';
const esc = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function imageUploader(value = '', label = 'Product image') {
  // Preserve a legacy image array on ordinary edits; replacement is explicit.
  value = Array.isArray(value) ? value[0] || '' : value;
  return `<div class="image-uploader full" data-image-uploader><span class="field-label">${esc(label)}</span><label class="upload-dropzone"><input data-upload-input type="file" accept="image/jpeg,image/png,image/webp,image/avif"><strong>${value ? 'Replace image' : 'Choose image from device'}</strong><small>JPEG, PNG, WebP or AVIF · up to 10 MB</small></label><img data-upload-preview ${value ? `src="${esc(optimizedImage(value, 300))}"` : 'hidden'} alt="Image preview"><input type="hidden" name="image" data-image-value value="${esc(value)}"><button type="button" class="small-btn danger" data-remove-image ${value ? '' : 'hidden'}>Remove image</button><progress data-upload-bar max="100" value="0" hidden aria-label="Image upload progress"></progress><p data-upload-progress class="upload-status" role="status" aria-live="polite">${value ? 'Current image. Changes apply when you save.' : 'No image selected.'}</p></div>`;
}
export async function uploadImageFile(file, widget, api) {
  if (widget.dataset.uploading) return;
  const status = widget.querySelector('[data-upload-progress]'), preview = widget.querySelector('[data-upload-preview]'), value = widget.querySelector('[data-image-value]'), bar = widget.querySelector('progress'), input = widget.querySelector('[data-upload-input]');
  let uploadId;
  try {
    status.classList.remove('error');
    if (!file || !['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(file.type) || file.size < 1 || file.size > 10 * 1024 * 1024) throw new Error('Choose a JPEG, PNG, WebP or AVIF image up to 10 MB.');
    widget.dataset.uploading = 'true'; input.disabled = true; bar.hidden = false; bar.value = 0;
    status.textContent = 'Preparing secure upload…';
    const signed = await api('/api/admin/media/uploads', { method: 'POST', body: JSON.stringify({ type: file.type, size: file.size }) });
    uploadId = signed.uploadId;
    const form = new FormData(); form.append('file', file); form.append('api_key', signed.apiKey); form.append('signature', signed.signature);
    for (const [key, val] of Object.entries(signed.params)) form.append(key, String(val));
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); xhr.open('POST', `https://api.cloudinary.com/v1_1/${encodeURIComponent(signed.cloudName)}/image/upload`); xhr.responseType = 'json'; xhr.timeout = 60000;
      xhr.upload.onprogress = event => { if (event.lengthComputable) { bar.value = Math.round(event.loaded / event.total * 100); status.textContent = `Uploading image… ${bar.value}%`; } };
      xhr.onerror = xhr.ontimeout = () => reject(new Error('Upload failed. Check your connection and choose the image again.'));
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.response?.error?.message || 'Image upload was rejected.'));
      xhr.send(form);
    });
    status.textContent = 'Verifying uploaded image…';
    const verified = await api(`/api/admin/media/uploads/${uploadId}/complete`, { method: 'POST', body: '{}' });
    if (!widget.isConnected) throw new Error('Upload cancelled.');
    if (widget.dataset.uploadId) await discardUpload(widget.dataset.uploadId, api);
    widget.dataset.uploadId = uploadId; uploadId = null;
    value.value = verified.image; preview.src = optimizedImage(verified.image, 300); preview.hidden = false;
    widget.querySelector('[data-remove-image]').hidden = false;
    status.textContent = 'Image ready. Save your changes to apply it.';
    widget.querySelector('.upload-dropzone strong').textContent = 'Replace image';
    delete widget.dataset.uploadError;
  } catch (error) {
    status.textContent = error.message; status.classList.add('error'); widget.dataset.uploadError = 'true';
    if (uploadId) await discardUpload(uploadId, api);
  } finally { delete widget.dataset.uploading; input.disabled = false; input.value = ''; bar.hidden = true; }
}
async function discardUpload(id, api) { try { await api(`/api/admin/media/uploads/${id}`, { method: 'DELETE' }); } catch { /* The server lease still schedules cleanup. */ } }
export async function removeImage(widget, api) {
  if (widget.dataset.uploading) return;
  if (widget.dataset.uploadId) await discardUpload(widget.dataset.uploadId, api);
  delete widget.dataset.uploadId; delete widget.dataset.uploadError;
  widget.querySelector('[data-image-value]').value = '';
  widget.querySelector('[data-upload-preview]').hidden = true;
  widget.querySelector('[data-remove-image]').hidden = true;
  widget.querySelector('[data-upload-progress]').textContent = 'Image removed. Save your changes to apply it.';
  const banner = widget.closest('[data-banner-card]');
  if (banner) {
    banner.querySelector('[data-banner-enabled]').checked = false;
    widget.querySelector('[data-upload-progress]').textContent = 'Image removed and banner disabled. Save your changes to apply it.';
  }
}
export function mediaReady(form) {
  const pending = form.querySelector('[data-uploading]');
  if (pending) { pending.scrollIntoView({ block: 'center' }); throw new Error('Wait for the image upload to finish before saving.'); }
  const failed = form.querySelector('[data-upload-error]');
  if (failed) throw new Error('An image upload failed. Retry it or remove the selection before saving.');
}
