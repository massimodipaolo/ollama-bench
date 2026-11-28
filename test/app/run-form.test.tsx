// @vitest-environment jsdom
/**
 * The /run form rendered in a simulated browser: what it offers for the host's models, starting a single-test
 * session and a capability batch, and showing a refusal. fetch and Next's router are stand-ins.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunForm } from '@/app/run/run-form';

const router = vi.hoisted(() => ({ push: vi.fn(), params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: router.push }), useSearchParams: () => router.params }));

const test = (id: string, name: string, o: Record<string, unknown> = {}) => ({
  id,
  name,
  description: `${name} description`,
  requires: ['completion'],
  requiresAny: [],
  judged: true,
  cliOnly: false,
  languages: ['en', 'it'],
  numCtx: 8192,
  options: [],
  caseCounts: { en: { quick: 4, full: 9 }, it: { quick: 3, full: 8 } },
  ...o,
});
const tests = {
  tests: [
    test('text-generation', 'Text generation'),
    test('image-recognition', 'Image recognition', { requires: ['completion', 'vision'] }),
    test('structured-output', 'Structured output'),
    test('terminal-bench', 'Terminal-Bench', { cliOnly: true, requires: ['completion', 'tools'] }),
  ],
  languages: [
    { code: 'en', name: 'English' },
    { code: 'it', name: 'Italiano' },
  ],
  judges: [{ id: 'openai', label: 'OpenAI', modelId: 'gpt-test' }],
};
const model = (name: string, capabilities: string[]) => ({
  name,
  parameterSize: '7B',
  quantization: 'Q4',
  capabilities,
  contextLength: 32768,
});

let posted: { url: string; body: Record<string, unknown> }[];
let refuse: string | null;
beforeEach(() => {
  posted = [];
  refuse = null;
  router.push.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/tests') return Response.json(tests);
      if (url === '/api/models')
        return Response.json({
          host: 'http://gpu:11434',
          models: [model('chat:7b', ['completion', 'tools']), model('seer:7b', ['completion', 'vision'])],
        });
      posted.push({ url, body: JSON.parse(String(init?.body)) });
      return refuse ? Response.json({ error: refuse }, { status: 400 }) : Response.json({ id: url === '/api/batches' ? 'b-1' : 's-1' });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const modelSelects = () => screen.getAllByRole('combobox').slice(0, 2); // Model A, Model B (top of the side panel)

describe('the run form', () => {
  it('offers only the models that can take the chosen test; a CLI-only test cannot be picked', async () => {
    render(<RunForm />);
    await screen.findByText('Text generation');
    const optionsOf = (s: HTMLElement) =>
      within(s)
        .getAllByRole('option')
        .map((o) => o.textContent);
    expect(optionsOf(modelSelects()[0])).toEqual(['Select…', expect.stringMatching(/^chat:7b/), expect.stringMatching(/^seer:7b/)]);
    fireEvent.click(screen.getByText('Image recognition'));
    expect(optionsOf(modelSelects()[0])).toEqual(['Select…', expect.stringMatching(/^seer:7b/)]);
    expect((screen.getByText('Terminal-Bench').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/1 of 2 models on/)).toBeTruthy();
  });

  it('starts a session with the chosen test, models and settings, then opens it', async () => {
    render(<RunForm />);
    await screen.findByText('Text generation');
    const run = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
    expect(run.disabled).toBe(true); // no model yet
    fireEvent.change(modelSelects()[0], { target: { value: 'chat:7b' } });
    fireEvent.change(modelSelects()[1], { target: { value: 'seer:7b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run comparison' }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/sessions/s-1'));
    expect(posted).toEqual([
      {
        url: '/api/sessions',
        body: {
          testId: 'text-generation',
          lang: 'en',
          models: ['chat:7b', 'seer:7b'],
          config: { subset: 'quick', think: false, temperature: 0, seed: 42, judges: ['openai'], extra: {} },
        },
      },
    ]);
  });

  it('shows the reason when the server refuses, and stays on the page', async () => {
    refuse = 'Model not found on Ollama host: chat:7b';
    render(<RunForm />);
    await screen.findByText('Text generation');
    fireEvent.change(modelSelects()[0], { target: { value: 'chat:7b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Model not found on Ollama host: chat:7b')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('capability mode starts a batch of the checked tests', async () => {
    render(<RunForm />);
    await screen.findByText('Text generation');
    fireEvent.click(screen.getByRole('tab', { name: 'Capability' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Structured output' })); // uncheck one
    fireEvent.change(modelSelects()[0], { target: { value: 'chat:7b' } });
    fireEvent.click(screen.getByRole('button', { name: /Start .* batch/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/batches/b-1'));
    expect(posted[0]).toMatchObject({
      url: '/api/batches',
      body: { capability: 'text', testIds: ['text-generation'], models: ['chat:7b'] },
    });
  });
});
