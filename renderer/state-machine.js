'use strict';
/**
 * Nanute — State Machine
 *
 * Controls:
 *   - CanvasEngine state transitions
 *   - Compact ↔ Expanded mode switching (via IPC)
 *   - Mouse passthrough toggling (hover detection)
 *   - Chat interaction (send / receive / typing)
 *   - Auto-demo cycle (showcases all animation states)
 *   - IPC bridge commands from main process
 */
(() => {
  // ── Safety check ──────────────────────────────────────────────────────────
  if (typeof window.bridge === 'undefined') {
    console.error('[Nanute] Bridge not available — preload failed.');
    return;
  }
  const bridge = window.bridge;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const root        = document.getElementById('root');
  const orbContainer= document.getElementById('orb-container');
  const chatArea    = document.getElementById('chat-area');
  const inputField  = document.getElementById('input-field');
  const sendBtn     = document.getElementById('send-btn');
  const closeBtn    = document.getElementById('close-btn');

  // ── App state ─────────────────────────────────────────────────────────────
  let isExpanded    = false;
  let isPaused      = false;
  let wasInOrb      = false;   // tracks whether cursor is over orb
  let typingEl      = null;    // reference to active typing indicator DOM node

  // ── Demo cycle ────────────────────────────────────────────────────────────
  // Runs automatically in compact mode to showcase all animation states.
  // Pauses when user is interacting or panel is expanded.
  const DEMO = [
    { state: 'idle',         ms: 3200 },
    { state: 'listening',    ms: 2400 },
    { state: 'processing',   ms: 1900 },
    { state: 'speaking',     ms: 2600 },
    { state: 'idle',         ms: 1800 },
    { state: 'notification', ms: 1400 },
    { state: 'idle',         ms: 3800 },
  ];
  let demoIdx     = 0;
  let demoTimer   = null;
  let demoRunning = false;

  function runDemoStep() {
    if (!demoRunning || isPaused || isExpanded) return;
    const { state, ms } = DEMO[demoIdx];
    CanvasEngine.setState(state);
    demoTimer = setTimeout(() => {
      demoIdx = (demoIdx + 1) % DEMO.length;
      runDemoStep();
    }, ms);
  }

  function startDemo() {
    if (demoRunning) return;
    demoRunning = true;
    runDemoStep();
  }

  function stopDemo() {
    demoRunning = false;
    if (demoTimer) { clearTimeout(demoTimer); demoTimer = null; }
  }

  // ── Mode switching ────────────────────────────────────────────────────────

  /**
   * Apply expanded CSS class — called AFTER main has resized the window.
   * Main sends 'mode:expanded' command, renderer applies CSS.
   */
  function applyExpandedMode() {
    isExpanded = true;
    stopDemo();
    CanvasEngine.setState('idle');
    root.classList.add('mode-expanded');
    root.classList.remove('mode-compact');
    // Give panel time to appear, then focus input
    setTimeout(() => inputField.focus(), 480);
  }

  /**
   * Apply compact CSS class — called after main has resized the window.
   */
  function applyCompactMode() {
    isExpanded = false;
    root.classList.remove('mode-expanded');
    root.classList.add('mode-compact');
    inputField.blur();
    // Restart demo after transition
    setTimeout(() => startDemo(), 500);
  }

  // ── Chat helpers ──────────────────────────────────────────────────────────

  const CANNED = [
    'Claro, estou verificando isso para você.',
    'Encontrei algumas opções relevantes.',
    'Entendido. Processando sua solicitação.',
    'Interessante. Deixa eu analisar melhor.',
    'Pronto. Aqui está o resultado.',
    'Posso ajudar com isso, sim.',
  ];

  function addMessage(text, role) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    chatArea.appendChild(el);
    chatArea.scrollTop = chatArea.scrollHeight;
    return el;
  }

  function showTyping() {
    if (typingEl) removeTyping();
    const el = document.createElement('div');
    el.className = 'typing-indicator';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'typing-dot';
      el.appendChild(dot);
    }
    chatArea.appendChild(el);
    chatArea.scrollTop = chatArea.scrollHeight;
    typingEl = el;
  }

  function removeTyping() {
    if (typingEl && typingEl.parentNode) typingEl.remove();
    typingEl = null;
  }

  function sendMessage() {
    const text = inputField.textContent.trim();
    if (!text) return;

    inputField.textContent = '';
    addMessage(text, 'user');
    stopDemo();
    CanvasEngine.setState('processing');
    showTyping();

    // Simulate async AI response
    const delay = 900 + Math.random() * 900;
    setTimeout(() => {
      removeTyping();
      CanvasEngine.setState('speaking');
      const resp = CANNED[Math.floor(Math.random() * CANNED.length)];
      addMessage(resp, 'assistant');

      setTimeout(() => {
        CanvasEngine.setState('idle');
        // No demo restart while panel remains open
      }, 2200);
    }, delay);
  }

  // ── Mouse passthrough management ──────────────────────────────────────────
  // In compact mode, the window ignores mouse events by default (forward:true).
  // When the cursor enters the orb area, we disable passthrough so the user
  // can click/drag. mousemove events are STILL delivered even in passthrough mode.

  const ORB_HIT_R = 34; // px from center — slightly larger than visual (26px)

  function setupMousePassthrough() {
    document.addEventListener('mousemove', (e) => {
      if (isExpanded) return; // panel captures all events

      const dx = e.clientX - 40; // center of 80×80 window
      const dy = e.clientY - 40;
      const inside = (dx * dx + dy * dy) < (ORB_HIT_R * ORB_HIT_R);

      if (inside !== wasInOrb) {
        wasInOrb = inside;
        bridge.send(inside ? 'mouse:capture' : 'mouse:ignore');
      }
    });

    document.addEventListener('mouseleave', () => {
      if (!isExpanded && wasInOrb) {
        wasInOrb = false;
        bridge.send('mouse:ignore');
      }
    });
  }

  // ── IPC from main process ─────────────────────────────────────────────────
  // Main sends commands for: pause/resume, mode changes (from tray menu)

  function setupIPC() {
    bridge.on('command', (cmd) => {
      switch (cmd) {
        case 'pause':
          isPaused = true;
          stopDemo();
          CanvasEngine.setState('paused');
          break;

        case 'resume':
          isPaused = false;
          CanvasEngine.setState('idle');
          if (!isExpanded) startDemo();
          break;

        case 'mode:expanded':
          applyExpandedMode();
          break;

        case 'mode:compact':
          applyCompactMode();
          break;
      }
    });
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Escape → collapse to compact
      if (e.key === 'Escape' && isExpanded) {
        bridge.send('overlay:compact');
        return;
      }
      // Enter → send message (if typing in input, no shift)
      if (e.key === 'Enter' && !e.shiftKey && isExpanded) {
        if (document.activeElement === inputField) {
          e.preventDefault();
          sendMessage();
        }
      }
    });
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  function setupEvents() {
    // Click on orb → tell main to expand (main resizes window, then sends command)
    orbContainer.addEventListener('click', () => {
      if (!isExpanded) bridge.send('overlay:expand');
    });

    // Close button → collapse
    closeBtn.addEventListener('click', () => {
      bridge.send('overlay:compact');
    });

    // Send button
    sendBtn.addEventListener('click', sendMessage);

    // Prevent input area from triggering drag (-webkit-app-region: drag is on header only,
    // but just in case)
    inputField.addEventListener('mousedown', (e) => e.stopPropagation());

    // Prevent rich-text paste — plain text only
    inputField.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    // Visual feedback: orb hover state (CSS can't do this because window is transparent)
    orbContainer.addEventListener('mouseenter', () => {
      if (!isExpanded) CanvasEngine.setState('idle'); // ensure idle glow on hover
    });

    setupKeyboard();
    setupMousePassthrough();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  function boot() {
    // Initialise canvas engine
    CanvasEngine.init(document.getElementById('orb-canvas'));

    setupEvents();
    setupIPC();
    startDemo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
