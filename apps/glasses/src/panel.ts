import type { AssistantApp, PanelState } from './app';

/**
 * The phone-side control panel.
 *
 * The glasses are the primary surface; this is what the wearer sees when they
 * pull out their phone — pairing link, a text input for when speaking out loud
 * is not an option, and a log for debugging.
 */
export function mountPanel(app: AssistantApp): void {
  const statusPill = document.getElementById('status-pill');
  const content = document.getElementById('content');
  const logEl = document.getElementById('log');
  const askBtn = document.getElementById('btn-ask');
  const agendaBtn = document.getElementById('btn-agenda');
  const syncBtn = document.getElementById('btn-sync');

  if (!statusPill || !content || !logEl || !askBtn || !agendaBtn || !syncBtn) return;

  askBtn.addEventListener('click', () => {
    const input = document.getElementById('ask-input') as HTMLInputElement | null;
    const text = input?.value.trim() ?? '';
    if (text) {
      if (input) input.value = '';
      void app.panelAction('ask', text);
    } else {
      void app.panelAction('ask');
    }
  });
  agendaBtn.addEventListener('click', () => void app.panelAction('agenda'));
  syncBtn.addEventListener('click', () => void app.panelAction('sync'));

  app.onPanelUpdate((state) => {
    statusPill.textContent = state.status;
    statusPill.className = `pill ${state.view === 'pairing' ? 'warn' : ''}`;
    content.replaceChildren(...renderContent(state, app));
    logEl.textContent = state.log.join('\n');
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderContent(state: PanelState, app: AssistantApp): Node[] {
  const nodes: Node[] = [];

  if (state.pairing) {
    const card = el('div', 'card');
    card.append(
      el('h2', undefined, 'Connect your Google account'),
      el('p', 'muted', 'Open this link on this phone, sign in, and the glasses will pick it up.'),
    );

    const link = el('a', 'btn primary block');
    link.textContent = 'Open the sign-in page';
    link.setAttribute('href', state.pairing.url);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer');
    card.append(link);

    card.append(el('p', 'code', state.pairing.code));
    nodes.push(card);
    return nodes;
  }

  const askCard = el('div', 'card');
  askCard.append(el('h2', undefined, 'Ask'));

  const input = el('input', 'input');
  input.id = 'ask-input';
  input.setAttribute('type', 'text');
  input.setAttribute(
    'placeholder',
    state.voiceEnabled ? 'Type, or hold the touchpad to speak' : 'Type a question',
  );
  input.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    void app.panelAction('ask', text);
  });
  askCard.append(input);

  // Mode switch, mirroring the glasses contextual menu.
  const modeRow = el('div', 'row');
  const modeLabel = el('span', 'muted small', state.mode === 'deep' ? 'Web search on' : 'Local data only');
  const modeBtn = el('button', 'btn small-btn', state.mode === 'deep' ? 'Turn web off' : 'Turn web on');
  modeBtn.addEventListener('click', () => {
    void app.panelAction('mode', state.mode === 'deep' ? 'fast' : 'deep');
  });
  modeRow.append(modeLabel, modeBtn);
  askCard.append(modeRow);

  if (state.lastAnswer) {
    askCard.append(
      el('p', 'muted small', state.lastQuestion ?? ''),
      el('p', 'answer', state.lastAnswer),
    );

    // The HUD can only show hostnames; here they are tappable.
    if (state.lastSources && state.lastSources.length > 0) {
      const list = el('ul', 'sources');
      for (const source of state.lastSources) {
        const row = el('li');
        const link = el('a');
        link.textContent = source.title || source.host;
        link.setAttribute('href', source.url);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noreferrer');
        row.append(link, el('span', 'muted small', source.host));
        list.append(row);
      }
      askCard.append(el('p', 'label', 'Sources'), list);
    }
  }
  nodes.push(askCard);

  // Unsplash's API terms require a visible credit linking to the photographer
  // and to Unsplash, with UTM parameters. The HUD cannot carry a link, so the
  // linked half lives here.
  if (state.photo) {
    const photoCard = el('div', 'card');
    photoCard.append(el('h2', undefined, 'Now showing'));

    // Hotlinked straight from the source CDN, which their production checklist
    // requires. The glasses get a re-rendered 4-bit version because they cannot
    // take anything else; this is the surface where the rule can be honoured.
    const thumb = el('img', 'thumb');
    thumb.setAttribute('src', state.photo.imageUrl);
    thumb.setAttribute('alt', state.photo.description ?? 'Photo');
    thumb.setAttribute('loading', 'lazy');
    photoCard.append(thumb);

    if (state.photo.description) {
      photoCard.append(el('p', 'muted', state.photo.description));
    }

    const credit = el('p', 'small');
    credit.append(document.createTextNode('Photo by '));

    const author = el('a');
    author.textContent = state.photo.photographer;
    author.setAttribute('href', state.photo.photographerUrl);
    author.setAttribute('target', '_blank');
    author.setAttribute('rel', 'noreferrer');

    const source = el('a');
    source.textContent = state.photo.source;
    source.setAttribute('href', state.photo.sourceUrl);
    source.setAttribute('target', '_blank');
    source.setAttribute('rel', 'noreferrer');

    credit.append(author, document.createTextNode(' on '), source);
    photoCard.append(credit, el('p', 'muted small', state.photo.position));
    nodes.push(photoCard);
  }

  const agendaCard = el('div', 'card');
  agendaCard.append(el('h2', undefined, 'Next up'));

  if (state.agenda.length === 0) {
    agendaCard.append(el('p', 'muted', 'Nothing on the calendar in the next two days.'));
  } else {
    const list = el('ul', 'list');
    for (const item of state.agenda.slice(0, 8)) {
      const row = el('li');
      row.append(
        el('span', 'when', item.relative),
        el('span', 'what', item.title),
        el('span', 'muted small', item.location ?? ''),
      );
      list.append(row);
    }
    agendaCard.append(list);
  }
  nodes.push(agendaCard);

  // Anthropic key. The panel is already authenticated, so the key never needs a
  // separate browser sign-in flow.
  const keyCard = el('div', 'card');
  keyCard.append(el('h2', undefined, 'Claude API key'));

  if (state.hasOwnApiKey) {
    keyCard.append(
      el('p', 'muted', `Using your own key (ends ...${state.apiKeyHint ?? ''}). Usage bills to your Anthropic account.`),
    );
    const remove = el('button', 'btn', 'Remove key');
    remove.addEventListener('click', () => {
      if (confirm('Remove your Anthropic key? The assistant will fall back to the server key, if there is one.')) {
        void app.panelAction('clear-key');
      }
    });
    keyCard.append(remove);
  } else {
    keyCard.append(
      el(
        'p',
        'muted',
        state.assistantReady
          ? 'Currently using the server key. Add your own to bill usage to your Anthropic account.'
          : 'The assistant needs a key before it can answer. Paste one from console.anthropic.com.',
      ),
    );

    const keyInput = el('input', 'input');
    keyInput.id = 'api-key-input';
    keyInput.setAttribute('type', 'password');
    keyInput.setAttribute('autocomplete', 'off');
    keyInput.setAttribute('placeholder', 'sk-ant-...');

    const save = el('button', 'btn primary', 'Save key');
    save.addEventListener('click', () => {
      const value = keyInput.value.trim();
      if (!value) return;
      keyInput.value = '';
      void app.panelAction('set-key', value);
    });

    keyCard.append(keyInput, save);
  }
  nodes.push(keyCard);

  const dangerCard = el('div', 'card');
  const unpair = el('button', 'btn danger', 'Unpair this device');
  unpair.addEventListener('click', () => {
    if (confirm('Disconnect this Google account from the glasses?')) {
      void app.panelAction('unpair');
    }
  });
  dangerCard.append(unpair);
  nodes.push(dangerCard);

  return nodes;
}
