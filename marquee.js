const dragThreshold = 5;
const scrollEdge = 48;
const scrollSpeed = 22;

export function attachMarquee(gallery, box, { enabled, getSelected, replace, rangeTo, setAnchor }) {
  let gesture;
  let frame;
  let suppressClick = false;

  function updatePointer(event) {
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    gesture.ctrl = event.ctrlKey;
    gesture.shift = event.shiftKey;
    gesture.dirty = true;
  }

  function draw() {
    const { x, y, startX, startY, ctrl, shift, initial } = gesture;
    const originX = startX - window.scrollX;
    const originY = startY - window.scrollY;
    const bounds = gallery.getBoundingClientRect();
    const left = Math.max(bounds.left, Math.min(x, originX));
    const right = Math.min(bounds.right, Math.max(x, originX));
    const top = Math.max(bounds.top, Math.min(y, originY));
    const bottom = Math.min(bounds.bottom, Math.max(y, originY));
    Object.assign(box.style, {
      left: `${left}px`, top: `${top}px`,
      width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px`
    });

    const hits = [];
    const ordered = [...gallery.children].map(card => {
      const area = card.querySelector('.thumb').getBoundingClientRect();
      const id = card.dataset.id;
      if (right > area.left && left < area.right && bottom > area.top && top < area.bottom) hits.push(id);
      return id;
    });
    const pointed = document.elementFromPoint(x, y)?.closest('#gallery > .card')?.dataset.id;
    const endpoint = hits.includes(pointed) ? pointed :
      (y < originY || (y === originY && x < originX) ? hits[0] : hits.at(-1));
    gesture.endpoint = endpoint;
    const target = new Set(shift && endpoint ? rangeTo(endpoint, gesture.startId) : hits);
    replace(ordered.filter(id => ctrl
      ? (shift ? initial.has(id) || target.has(id) : initial.has(id) !== target.has(id))
      : target.has(id)));
    gesture.dirty = false;
  }

  function scrollAtEdge() {
    const { x, y } = gesture;
    const galleryBounds = gallery.getBoundingClientRect();
    const height = document.documentElement.clientHeight;
    if (x < galleryBounds.left - scrollEdge || x > galleryBounds.right + scrollEdge) return false;
    let speed = 0;
    if (y < scrollEdge && galleryBounds.top < 0) {
      speed = -Math.min(1, (scrollEdge - y) / scrollEdge);
    } else if (y > height - scrollEdge && galleryBounds.bottom > height) {
      speed = Math.min(1, (y - height + scrollEdge) / scrollEdge);
    }
    if (!speed) return false;
    const oldY = window.scrollY;
    window.scrollBy({ top: Math.sign(speed) * Math.ceil(Math.abs(speed) * scrollSpeed), behavior: 'instant' });
    return window.scrollY !== oldY;
  }

  function animate() {
    if (!enabled()) {
      finish(false);
      return;
    }
    const scrolled = scrollAtEdge();
    if (scrolled || gesture.dirty) draw();
    frame = requestAnimationFrame(animate);
  }

  function finish(commit) {
    if (!gesture) return;
    const { dragging, pointerId } = gesture;
    if (dragging) {
      if (commit) {
        draw();
        if (!gesture.shift && gesture.endpoint) setAnchor(gesture.endpoint);
      } else replace([...gesture.initial]);
      suppressClick = true;
    }
    gesture = undefined;
    cancelAnimationFrame(frame);
    box.hidden = true;
    gallery.classList.remove('marquee-dragging');
    if (gallery.hasPointerCapture(pointerId)) gallery.releasePointerCapture(pointerId);
  }

  gallery.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (gesture || !enabled() || !event.isPrimary || event.pointerType !== 'mouse' || event.button !== 0 ||
        event.target.closest('.card-footer')) return;
    gesture = {
      pointerId: event.pointerId,
      initial: new Set(getSelected()),
      startId: event.target.closest('.card')?.dataset.id,
      startX: event.clientX + window.scrollX,
      startY: event.clientY + window.scrollY,
      dragging: false
    };
    updatePointer(event);
  });
  window.addEventListener('pointermove', event => {
    if (event.pointerId !== gesture?.pointerId) return;
    if (!enabled() || !(event.buttons & 1)) {
      finish(false);
      return;
    }
    updatePointer(event);
    if (gesture.dragging || Math.hypot(gesture.x + window.scrollX - gesture.startX,
      gesture.y + window.scrollY - gesture.startY) < dragThreshold) return;
    gesture.dragging = true;
    gallery.setPointerCapture(event.pointerId);
    gallery.classList.add('marquee-dragging');
    box.hidden = false;
    animate();
  });
  window.addEventListener('pointerup', event => {
    if (event.pointerId !== gesture?.pointerId) return;
    updatePointer(event);
    finish(enabled());
  });
  function cancelPointer(event) {
    if (event.pointerId === gesture?.pointerId) finish(false);
  }
  window.addEventListener('pointercancel', cancelPointer);
  gallery.addEventListener('lostpointercapture', cancelPointer);
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('scroll', () => { if (gesture) gesture.dirty = true; }, { passive: true });
  function modifier(event) {
    if (!gesture) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Control' || event.key === 'Shift') {
      gesture.ctrl = event.ctrlKey;
      gesture.shift = event.shiftKey;
      gesture.dirty = true;
    }
  }
  window.addEventListener('keydown', modifier);
  window.addEventListener('keyup', modifier);
  gallery.addEventListener('click', event => {
    if (suppressClick && event.detail > 0) {
      event.stopImmediatePropagation();
      event.preventDefault();
      suppressClick = false;
    }
  }, true);
}
