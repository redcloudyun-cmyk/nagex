// R10.2-D Increment 2 — read-only catalog/listing routes, extracted
// verbatim from server_web.ts's handleApiRequest: plans, skills, tools,
// agents, knowledge. planRegistry/knowledgeBase (static demo/seed data,
// each previously used by exactly one route) moved here with their only
// consumer; skillRegistry/toolRegistry are the real canonical singletons,
// imported directly (ES module caching — the same instance server_web.ts
// itself uses elsewhere). No mutation, no approval, no tenant scoping
// required by any of these five routes (unchanged from the original).
import { skillRegistry as canonicalSkillRegistry } from '../../skills/skill-registry.js';
import { toolRegistry as canonicalToolRegistry } from '../../tools/tool-registry.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

const planRegistry: Array<{
  id: string;
  goal: string;
  description: string;
  status: string;
  tags: string[];
  progress: number;
  completed_steps: number;
  total_steps: number;
  created_at: string;
  steps: Array<{
    step: number;
    title: string;
    status: string;
    skill: string;
    tool: string;
    approval: string;
    due: string;
    result: string;
  }>;
}> = [
  {
    id: 'plan_acme_meeting',
    goal: 'Prepare Client Meeting',
    description: 'Prepare for the Acme Corp. quarterly business review meeting.',
    status: 'RUNNING',
    tags: ['Client Meeting', 'Acme Corp', '🔥 High Priority'],
    progress: 62,
    completed_steps: 5,
    total_steps: 8,
    created_at: new Date(Date.now() - 3600000).toISOString(),
    steps: [
      { step: 1, title: 'Understand meeting context', status: 'Completed', skill: 'Memory Recall', tool: 'NAgex Memory', approval: '-', due: 'Apr 28, 9:00 AM', result: 'View' },
      { step: 2, title: 'Research client and industry', status: 'Completed', skill: 'Web Research', tool: 'Perplexity', approval: '-', due: 'Apr 28, 11:00 AM', result: 'View' },
      { step: 3, title: 'Summarize key talking points', status: 'Running', skill: 'Summarization', tool: 'Notion', approval: '-', due: 'Apr 29, 9:00 AM', result: '...' },
      { step: 4, title: 'Draft meeting deck', status: 'Ready', skill: 'Content Creation', tool: 'Google Slides', approval: 'Required', due: 'Apr 29, 2:00 PM', result: '-' },
      { step: 5, title: 'Get stakeholder review', status: 'Awaiting Approval', skill: 'Communication', tool: 'Gmail', approval: 'Required', due: 'Apr 29, 5:00 PM', result: '-' },
      { step: 6, title: 'Schedule the meeting', status: 'Ready', skill: 'Scheduling', tool: 'Google Calendar', approval: '-', due: 'Apr 30, 9:00 AM', result: '-' },
      { step: 7, title: 'Prepare Q&A responses', status: 'Ready', skill: 'Analysis', tool: 'ChatGPT', approval: '-', due: 'Apr 30, 11:00 AM', result: '-' },
      { step: 8, title: 'Final review and checklist', status: 'Ready', skill: 'Project Management', tool: 'Notion', approval: '-', due: 'Apr 30, 3:00 PM', result: '-' },
    ],
  },
  {
    id: 'plan_002',
    goal: 'Weekly Competitive Market Analysis',
    description: 'Gather competitors intelligence and prepare executive deck.',
    status: 'RUNNING',
    tags: ['Market Research', 'Executive Summary'],
    progress: 33,
    completed_steps: 1,
    total_steps: 3,
    created_at: new Date(Date.now() - 1800000).toISOString(),
    steps: [
      { step: 1, title: 'Search latest market trends via Web Search', status: 'Completed', skill: 'Deep Research', tool: 'Web Search', approval: '-', due: 'Apr 29, 10:00 AM', result: 'View' },
      { step: 2, title: 'Synthesize insights into Executive Brief', status: 'Running', skill: 'Document Summary', tool: 'Browser', approval: '-', due: 'Apr 29, 2:00 PM', result: '...' },
      { step: 3, title: 'Distribute summary to Slack #executive channel', status: 'Ready', skill: 'Executive Update', tool: 'Slack', approval: 'Required', due: 'Apr 29, 4:00 PM', result: '-' },
    ],
  },
];

const knowledgeBase = [
  { id: 'kb_001', name: 'Acme_QBR_Notes.pdf', classification: 'CONFIDENTIAL', size_bytes: 2516582, status: 'INDEXED', indexed_at: '2026-08-20T14:30:00Z', chunk_count: 142 },
  { id: 'kb_002', name: 'Product_Strategy_2025.docx', classification: 'INTERNAL', size_bytes: 1153433, status: 'INDEXED', indexed_at: '2026-08-19T09:15:00Z', chunk_count: 87 },
];

export const handleCatalogRoutes: SyncRouteRegistrar<Record<string, never>> = (method, pathname): ApiResult | undefined => {
  if (pathname === '/api/v1/plans' && method === 'GET') {
    return { status: 200, data: { plans: planRegistry, total: planRegistry.length } };
  }
  if (pathname === '/api/v1/skills' && method === 'GET') {
    const skills = canonicalSkillRegistry.list();
    return { status: 200, data: { skills, total: skills.length } };
  }
  if (pathname === '/api/v1/tools' && method === 'GET') {
    const tools = canonicalToolRegistry.list();
    return { status: 200, data: { tools, total: tools.length } };
  }
  if (pathname === '/api/v1/agents' && method === 'GET') {
    const agents = canonicalSkillRegistry.list();
    return { status: 200, data: { agents, total: agents.length } };
  }
  if (pathname === '/api/v1/knowledge' && method === 'GET') {
    return { status: 200, data: { documents: knowledgeBase, total: knowledgeBase.length } };
  }
  return undefined;
};
