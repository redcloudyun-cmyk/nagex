export interface RegisteredSkill {
  id: string;
  name: string;
  description: string;
  aliases: readonly string[];
}

export interface SkillResolution {
  requestedSkill: string;
  status: 'RESOLVED' | 'UNRESOLVED';
  resolvedSkillId: string | null;
  resolvedSkillName: string | null;
}

function normalizeRegistryName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class SkillRegistry {
  private readonly skills: RegisteredSkill[];
  private readonly lookup = new Map<string, RegisteredSkill>();

  constructor(skills: RegisteredSkill[]) {
    this.skills = skills.map((skill) => Object.freeze({ ...skill, aliases: [...skill.aliases] }));
    for (const skill of this.skills) {
      for (const candidate of [skill.id, skill.name, ...skill.aliases]) {
        const key = normalizeRegistryName(candidate);
        const existing = this.lookup.get(key);
        if (existing && existing.id !== skill.id) throw new Error(`Duplicate skill registry alias: ${candidate}`);
        this.lookup.set(key, skill);
      }
    }
  }

  public list(): readonly RegisteredSkill[] {
    return this.skills;
  }

  public resolve(requestedSkill: string): SkillResolution {
    const skill = this.lookup.get(normalizeRegistryName(requestedSkill));
    return skill
      ? { requestedSkill, status: 'RESOLVED', resolvedSkillId: skill.id, resolvedSkillName: skill.name }
      : { requestedSkill, status: 'UNRESOLVED', resolvedSkillId: null, resolvedSkillName: null };
  }
}

export const skillRegistry = new SkillRegistry([
  { id: 'skill.memory_recall', name: 'Memory Recall', description: 'Retrieve relevant NAgex memory.', aliases: ['memory', 'recall memory'] },
  { id: 'skill.meeting_preparation', name: 'Meeting Preparation', description: 'Prepare meeting context and materials.', aliases: ['meeting prep', 'prepare meeting'] },
  { id: 'skill.email_drafting', name: 'Email Drafting', description: 'Draft email content without sending it.', aliases: ['draft email', 'communication'] },
  { id: 'skill.deep_research', name: 'Deep Research', description: 'Research and synthesize sources.', aliases: ['web research', 'research'] },
  { id: 'skill.document_summary', name: 'Document Summary', description: 'Summarize documents and notes.', aliases: ['summarization', 'summarize'] },
  { id: 'skill.scheduling', name: 'Scheduling', description: 'Prepare scheduling actions.', aliases: ['calendar scheduling', 'schedule meeting'] },
  { id: 'skill.planning', name: 'Planning', description: 'Create and refine action plans.', aliases: ['task planning'] },
]);
