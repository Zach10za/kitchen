/**
 * Tasks agent tool definitions. All state mutations go through these tools;
 * the executor lives in tasks/loop.ts and is called from TasksDO's
 * /workflow/tasks/exec-tool endpoint.
 */

export const TASKS_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'show_summary',
      description: 'Get a high-level summary of the task list: counts by status, next ready tasks, and any blocked tasks. Call this first when the user asks an open-ended question about their tasks or asks what they should work on.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_tasks',
      description: 'List tasks with optional filters. Returns id, title, status, type, priority, due date, parent, dependency count. Always ordered: in-progress → todo → blocked, then urgent → low, then soonest due.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['todo', 'in_progress', 'blocked', 'done', 'cancelled', 'open'],
            description: 'Filter by status. "open" means todo+in_progress+blocked. Omit for all.',
          },
          type: {
            type: 'string',
            enum: ['short', 'long'],
            description: 'Filter by task type. Omit for all.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: 'Filter by priority. Omit for all.',
          },
          parent_id: {
            type: 'string',
            description: 'Only return subtasks of this parent task ID. Omit for top-level tasks.',
          },
          include_done: {
            type: 'boolean',
            description: 'Include done/cancelled tasks. Default false unless status is explicitly set.',
          },
          due_within_days: {
            type: 'number',
            description: 'Only return tasks due within this many days. 0 means overdue + due today.',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_task',
      description: 'Get full details of a specific task: title, status, type, notes, subtasks, and dependencies (both blockers and what this task blocks). Use when the user asks about a specific task or you need to inspect before editing.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID (starts with t_).' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_task',
      description: 'Create a new task. Returns the new task ID. For subtasks, provide parent_id. Short tasks are quick single-session items; long tasks span multiple sessions or have subtasks. Set priority and due_date when the user signals urgency or a deadline.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Clear, actionable task title.' },
          type: {
            type: 'string',
            enum: ['short', 'long'],
            description: 'short = quick, single-session. long = multi-session, may have subtasks. Default short.',
          },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: 'Default normal. Use urgent only for true emergencies. high = important and time-sensitive. low = nice-to-have.',
          },
          notes: { type: 'string', description: 'Optional details, context, or acceptance criteria.' },
          parent_id: { type: 'string', description: 'Parent task ID to make this a subtask. Omit for top-level.' },
          due_date: {
            type: 'string',
            description: 'Optional deadline. Accepts YYYY-MM-DD (interpreted as end-of-day UTC) or full ISO-8601 datetime.',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_task',
      description: 'Update a task\'s status, title, type, priority, notes, or due date. Only provide fields you want to change. To complete a task, set status to "done". To cancel, set "cancelled". To start, set "in_progress". Pass due_date as null to clear an existing deadline.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task ID to update.' },
          title: { type: 'string', description: 'New title.' },
          status: {
            type: 'string',
            enum: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'],
            description: 'New status.',
          },
          type: { type: 'string', enum: ['short', 'long'], description: 'New type.' },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: 'New priority.',
          },
          notes: { type: 'string', description: 'New notes (replaces existing).' },
          due_date: {
            type: ['string', 'null'],
            description: 'YYYY-MM-DD or ISO-8601 datetime. Pass null to clear the existing due date.',
          },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_dependency',
      description: 'Add a dependency: task A cannot start until task B is done. Use when one task is blocked by another. Prevents cycles.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task that is blocked (depends on the other).' },
          depends_on_id: { type: 'string', description: 'The task that must be completed first.' },
        },
        required: ['task_id', 'depends_on_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remove_dependency',
      description: 'Remove a dependency between two tasks — unblocks task_id from depends_on_id.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The blocked task.' },
          depends_on_id: { type: 'string', description: 'The task that was the blocker.' },
        },
        required: ['task_id', 'depends_on_id'],
      },
    },
  },
  // ── OpenAI server-side built-ins ──────────────────────────────────────
  // Executes on OpenAI's side; output appears in the response alongside our
  // function calls and we echo it forward — no executor on our side. Available
  // when a specific task needs a fact looked up; not central to task management.
  { type: 'web_search' as const },
] as const;

// ─── TypeScript Row Types ─────────────────────────────────────────────

export interface TaskRow {
  id: string;
  title: string;
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  type: 'short' | 'long';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  parent_id: string | null;
  notes: string | null;
  due_at: number | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export interface TaskDepRow {
  id: number;
  task_id: string;
  depends_on_id: string;
  [key: string]: SqlStorageValue;
}
