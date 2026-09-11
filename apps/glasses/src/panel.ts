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

  if (state.lastAnswer) {
    askCard.append(
      el('p', 'muted small', state.lastQuestion ?? ''),
      el('p', 'answer', state.lastAnswer),
    );
  }
  nodes.push(askCard);

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
