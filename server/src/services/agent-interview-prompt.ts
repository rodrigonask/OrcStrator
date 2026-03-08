import type { AgentConfig } from '@orcstrator/shared'

const INTERVIEW_QUESTIONS = [
  'What is this agent\'s primary role in one sentence?',
  'When the user gives an unclear request, should it ask for clarification or act on best-guess?',
  'What tools does it need? Every tool costs tokens — list only what is essential.',
  'What should this agent NEVER do, even if asked?',
  'How formal or casual should its communication style be?',
  'Should it maintain memory across sessions, or start fresh each time?',
  'What is its success metric for a task?',
  'What triggers it to escalate or pause for human review?',
  'What personality traits define it? (e.g. cautious, bold, methodical, creative)',
  'Any specific domain knowledge or constraints it must always respect?',
]

export function buildInterviewPrompt(agent: AgentConfig): string {
  const currentContent = agent.content?.trim()
    ? `\n\nHere is the agent's current prompt/content for reference:\n\`\`\`\n${agent.content}\n\`\`\``
    : ''

  return `You are helping the user refine the agent "${agent.name}". Your job is to conduct a structured interview to understand this agent's personality, behavior, and constraints. After collecting answers, you'll help generate an improved agent prompt.${currentContent}

Walk through these questions one at a time. Ask the first question now, then wait for the user's answer before proceeding to the next. After all questions are answered, synthesize the responses into a refined agent prompt.

Questions to cover:
${INTERVIEW_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Start with question 1 now.`
}
