// @vitest-environment jsdom
/**
 * AddBotViaGithub tests
 *
 * The panel's BOT_GUIDE deep link is built from the shared REPO_URL (#183);
 * this pins that it still resolves to the guide's "submitting your bot"
 * anchor, so moving the repo constant can't silently break the CTA.
 */

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { AddBotViaGithub } from '../../src/ui/AddBotViaGithub.jsx';
import { REPO_URL } from '../../src/ui/menuChrome.jsx';

let container;

afterEach(() => {
  if (container) {
    act(() => render(null, container));
    if (container.parentNode) document.body.removeChild(container);
    container = null;
  }
});

describe('AddBotViaGithub', () => {
  it('derives the bot-guide link from the shared REPO_URL', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => render(h(AddBotViaGithub, {}), container));

    const link = container.querySelector('a');
    expect(link.getAttribute('href')).toBe(
      `${REPO_URL}/blob/master/docs/BOT_GUIDE.md#submitting-your-bot`
    );
    expect(link.getAttribute('href').startsWith(REPO_URL)).toBe(true);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
