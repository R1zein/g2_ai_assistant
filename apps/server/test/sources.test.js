import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ENCRYPTION_KEY = 'a-test-passphrase-long-enough-to-pass';
process.env.GOOGLE_CLIENT_ID ??= 'test.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET ??= 'test-secret';

const { collectSources, collectServerSteps, hostOf } = await import('../dist/ai/agent.js');

test('hostOf strips the scheme and a leading www', () => {
  assert.equal(hostOf('https://www.lufthansa.com/de/en/flight-status'), 'lufthansa.com');
  assert.equal(hostOf('http://example.co.uk/x?y=1'), 'example.co.uk');
  assert.equal(hostOf('not a url'), 'not a url');
});

test('collectSources reads a successful web search result', () => {
  const into = [];
  collectSources(
    [
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          { type: 'web_search_result', title: 'Flight status', url: 'https://www.lufthansa.com/status', encrypted_content: 'x' },
          { type: 'web_search_result', title: 'Airport', url: 'https://muc.example/arrivals', encrypted_content: 'y' },
        ],
      },
    ],
    into,
  );

  assert.equal(into.length, 2);
  assert.deepEqual(into[0], {
    title: 'Flight status',
    url: 'https://www.lufthansa.com/status',
    host: 'lufthansa.com',
  });
});

test('a failed search puts an error object where the array would be', () => {
  // This is the documented shape trap: success is a list, failure is an object.
  const into = [];
  collectSources(
    [
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_2',
        content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
      },
    ],
    into,
  );
  assert.deepEqual(into, []);
});

test('collectSources reads a fetched page and skips a fetch error', () => {
  const into = [];
  collectSources(
    [
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srvtoolu_3',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.org/opening-hours',
          retrieved_at: '2026-09-11T10:00:00Z',
          content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '…' } },
        },
      },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srvtoolu_4',
        content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
      },
    ],
    into,
  );

  assert.equal(into.length, 1);
  assert.equal(into[0].host, 'example.org');
});

test('collectServerSteps describes what the model did on the server', () => {
  const steps = [];
  collectServerSteps(
    [
      { type: 'server_tool_use', id: 'a', name: 'web_search', input: { query: 'LH992 status today' } },
      { type: 'server_tool_use', id: 'b', name: 'web_fetch', input: { url: 'https://www.lufthansa.com/x' } },
    ],
    steps,
  );

  assert.equal(steps.length, 2);
  assert.match(steps[0].summary, /Searched the web for "LH992 status today"/);
  assert.equal(steps[1].summary, 'Read lufthansa.com');
  assert.ok(steps.every((s) => s.ok));
});
