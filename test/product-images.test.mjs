import test from 'node:test';
import assert from 'node:assert/strict';
import { distinctProductImageSources } from '../public/product-images.js';

test('product image sources retain one primary image and deduplicate repeated gallery and fallback paths', () => {
  assert.deepEqual(distinctProductImageSources({
    image: '/assets/banana.jpg',
    images: ['/assets/banana.jpg', '/assets/banana-side.jpg', '/assets/banana-side.jpg']
  }), ['/assets/banana.jpg', '/assets/banana-side.jpg']);
});

test('product image sources keep one entry when no distinct gallery image is configured', () => {
  assert.deepEqual(distinctProductImageSources({ image: '/assets/banana.jpg' }), ['/assets/banana.jpg']);
  assert.deepEqual(distinctProductImageSources({ images: ['/assets/banana.jpg', '/assets/banana.jpg'] }), ['/assets/banana.jpg']);
  assert.deepEqual(distinctProductImageSources({}), []);
});
