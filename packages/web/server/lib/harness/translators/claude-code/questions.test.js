import { afterEach, describe, expect, it } from 'bun:test';
import {
  createAskUserQuestionHandler,
  rejectPendingForSession,
  replyQuestion,
  resetPendingQuestions,
} from './questions.js';

afterEach(() => {
  resetPendingQuestions();
});

function sampleInput() {
  return {
    questions: [
      {
        question: 'How should I format the output?',
        header: 'Format',
        options: [
          { label: 'Summary', description: 'Brief overview' },
          { label: 'Detailed', description: 'Full explanation' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which sections should I include?',
        header: 'Sections',
        options: [
          { label: 'Introduction', description: 'Opening context' },
          { label: 'Conclusion', description: 'Final summary' },
        ],
        multiSelect: true,
      },
    ],
  };
}

describe('createAskUserQuestionHandler', () => {
  it('emits question.asked and resolves with answers on reply', async () => {
    const events = [];
    const handler = createAskUserQuestionHandler({
      sessionId: 'ses_1',
      directory: '/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'qst_fixed',
      assistantMessageId: 'msg_assistant',
    });

    const pending = handler(sampleInput(), { toolUseID: 'toolu_1' });

    expect(events[0]?.type).toBe('question.asked');
    expect(events[0]?.properties).toMatchObject({
      id: 'qst_fixed',
      sessionID: 'ses_1',
      questions: [
        { question: 'How should I format the output?', header: 'Format', multiple: false },
        { question: 'Which sections should I include?', header: 'Sections', multiple: true },
      ],
      tool: {
        messageID: 'msg_assistant',
        callID: 'toolu_1',
      },
    });

    replyQuestion({
      sessionId: 'ses_1',
      requestId: 'qst_fixed',
      answers: [['Summary'], ['Introduction', 'Conclusion']],
    });

    const result = await pending;
    expect(result).toMatchObject({
      behavior: 'allow',
      updatedInput: {
        answers: {
          'How should I format the output?': 'Summary',
          'Which sections should I include?': 'Introduction, Conclusion',
        },
      },
    });
    expect(events.some((event) => event.type === 'question.replied')).toBe(true);
  });

  it('rejects with deny when the user dismisses the question', async () => {
    const events = [];
    const handler = createAskUserQuestionHandler({
      sessionId: 'ses_2',
      directory: '/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'qst_deny',
    });

    const pending = handler(sampleInput(), {});
    replyQuestion({ sessionId: 'ses_2', requestId: 'qst_deny', reject: true });

    const result = await pending;
    expect(result).toEqual({ behavior: 'deny', message: 'User declined' });
    expect(events.some((event) => event.type === 'question.rejected')).toBe(true);
  });

  it('denies when the question list is missing', async () => {
    const handler = createAskUserQuestionHandler({
      sessionId: 'ses_3',
      directory: '/project',
      getBroadcast: () => () => {},
    });

    await expect(handler({}, {})).resolves.toEqual({
      behavior: 'deny',
      message: 'No valid questions',
    });
  });

  it('denies when the abort signal is already aborted', async () => {
    const handler = createAskUserQuestionHandler({
      sessionId: 'ses_4',
      directory: '/project',
      getBroadcast: () => () => {},
    });
    const controller = new AbortController();
    controller.abort();

    const result = await handler(sampleInput(), { signal: controller.signal });
    expect(result).toEqual({ behavior: 'deny', message: 'Question request aborted' });
  });

  it('aborts an outstanding question when the signal fires', async () => {
    const events = [];
    const handler = createAskUserQuestionHandler({
      sessionId: 'ses_5',
      directory: '/project',
      getBroadcast: () => (payload) => events.push(payload),
      createId: () => 'qst_abort',
    });

    const controller = new AbortController();
    const pending = handler(sampleInput(), { signal: controller.signal });
    controller.abort();

    const result = await pending;
    expect(result).toEqual({ behavior: 'deny', message: 'Question request aborted' });
    expect(events.some((event) => event.type === 'question.rejected')).toBe(true);
  });

  it('rejects replies for unknown or mismatched sessions', () => {
    createAskUserQuestionHandler({
      sessionId: 'ses_6',
      directory: '/project',
      getBroadcast: () => () => {},
      createId: () => 'qst_mismatch',
    })(sampleInput(), {});

    expect(() => replyQuestion({
      sessionId: 'ses_other',
      requestId: 'qst_mismatch',
      answers: [['Summary']],
    })).toThrow(/does not belong/);

    expect(() => replyQuestion({
      sessionId: 'ses_6',
      requestId: 'missing',
      answers: [['Summary']],
    })).toThrow(/not found/);
  });
});

describe('rejectPendingForSession', () => {
  it('rejects all pending questions for a session', async () => {
    const handler = createAskUserQuestionHandler({
      sessionId: 'ses_multi',
      directory: '/project',
      getBroadcast: () => () => {},
      createId: () => 'qst_multi',
    });

    const pending = handler(sampleInput(), {});
    expect(rejectPendingForSession('ses_multi')).toBe(1);

    const result = await pending;
    expect(result).toEqual({ behavior: 'deny', message: 'Turn ended' });
  });
});
