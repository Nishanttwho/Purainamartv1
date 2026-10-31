// Discovery only: the existing staff APIs authenticate and authorize every request.
export function installStaffAccess(logo, openStaffAccess) {
  if (!logo) return;
  let timer, pointer, startX, startY, suppressClick = false;
  function cancelHold() {
    clearTimeout(timer);
    timer = undefined;
    pointer = undefined;
  }
  logo.addEventListener('pointerdown', event => {
    cancelHold();
    suppressClick = false;
    if (!event.isPrimary || event.button !== 0) return;
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    timer = setTimeout(() => {
      cancelHold();
      suppressClick = true;
      openStaffAccess();
    }, 5000);
  });
  logo.addEventListener('pointermove', event => {
    if (event.pointerId === pointer && Math.hypot(event.clientX - startX, event.clientY - startY) > 12) cancelHold();
  });
  logo.addEventListener('pointerleave', cancelHold);
  document.addEventListener('pointerdown', event => {
    if (pointer !== undefined && event.pointerId !== pointer) cancelHold();
  });
  document.addEventListener('pointerup', cancelHold);
  document.addEventListener('pointercancel', cancelHold);
  document.addEventListener('scroll', cancelHold, true);
  document.addEventListener('visibilitychange', cancelHold);
  window.addEventListener('blur', cancelHold);
  logo.addEventListener('contextmenu', event => event.preventDefault());
  logo.addEventListener('dragstart', event => { event.preventDefault(); cancelHold(); });
  // Consume the release click so a completed hold cannot navigate back home.
  logo.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
