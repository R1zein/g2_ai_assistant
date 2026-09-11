import './styles.css';
import { AssistantApp } from './app';
import { mountPanel } from './panel';

const app = new AssistantApp();
mountPanel(app);

app.start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[assistant] failed to start', err);

  const content = document.getElementById('content');
  if (content) {
    content.textContent = `The app could not start: ${message}`;
  }
});

// Hardware left running past teardown stays running on the glasses.
window.addEventListener('beforeunload', () => {
  void app.stop();
});
