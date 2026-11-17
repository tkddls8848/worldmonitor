/**
 * #9213: digest stories carry the story's corroboration, read from the verdict
 * list-feed-digest stored on the story's track row. The chat, email and
 * delivery-plan formatters left with the personal build's delivery channels.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STORY_CORROBORATION_FIELD } from '../server/_shared/label-history';
import {
  attachDigestCorroboration,
  digestWebhookStory,
  readStoryCorroboration,
  storyCorroborationField,
} from '../scripts/lib/digest-corroboration.mjs';

describe('the stored verdict', () => {
  it('is read from the server\'s field for the digest\'s own variant', () => {
    for (const [variant, lang] of [['full', 'en'], ['tech', 'en'], ['full', 'fr']]) {
      assert.equal(storyCorroborationField(variant, lang), STORY_CORROBORATION_FIELD(variant, lang));
    }
    const track = { 'corroboration:full:en': 'corroborated|3', 'corroboration:tech:en': 'single-publisher|1' };
    assert.equal(readStoryCorroboration(track, 'full', 'en'), 'corroborated|3');
    assert.equal(readStoryCorroboration(track, 'tech', 'en'), 'single-publisher|1');
    assert.equal(readStoryCorroboration(track, 'finance', 'en'), '');
    assert.equal(readStoryCorroboration(undefined, 'full', 'en'), '');
  });

  it('is attached to each digest story from the hashes it was merged from', () => {
    const stories = [
      { hash: 'h1', corroboration: 'single-publisher|1' },
      { hash: 'h2', corroboration: 'corroborated|3' },
      { hash: 'h3', corroboration: 'single-publisher|1' },
      { hash: 'h4', corroboration: '' },
    ];
    const reps = [
      { hash: 'h1', mergedHashes: ['h1', 'h2'], sources: ['Reuters World', 'BBC World'] },
      { hash: 'h3', sources: ['Reuters World', 'Reuters Business'] },
      { hash: 'h4', mergedHashes: ['h4'], sources: ['AP News'] },
    ];
    attachDigestCorroboration(reps, stories);
    assert.deepEqual(reps.map((rep) => rep.corroboration), [
      { state: 'corroborated', publishers: 3 },
      { state: 'single-publisher', publishers: 1 },
      null,
    ]);
  });
});

const story = (corroboration: unknown, title = 'Port strike halts container traffic') => ({
  title, severity: 'high', phase: 'sustained', sources: ['Reuters'], link: 'https://www.reuters.com/x',
  description: '', hash: `c-${title}`, ...(corroboration === undefined ? {} : { corroboration }),
});

describe('an unmerged reprinted story', () => {
  it('keeps the stored single-publisher verdict although its feed labels are two families', () => {
    const reps = [{ hash: 'r1', mergedHashes: ['r1'], sources: ['Reuters World', 'Harbour Gazette'] }];
    attachDigestCorroboration(reps, [{ hash: 'r1', corroboration: 'single-publisher|1' }]);
    assert.deepEqual(reps[0]!.corroboration, { state: 'single-publisher', publishers: 1 });
  });
});

describe('digest webhook', () => {
  it('carries the verdict as a structured field on each story, only when known', () => {
    const known = digestWebhookStory(story({ state: 'single-publisher', publishers: 1 }));
    assert.deepEqual(known, {
      title: 'Port strike halts container traffic', severity: 'high', phase: 'sustained', sources: ['Reuters'],
      corroboration: { state: 'single-publisher', publishers: 1 },
    });
    assert.equal('corroboration' in digestWebhookStory(story(null)), false);
  });
});
