/**
 * Tasks agent tool definitions. All state mutations go through these tools;
 * the executor lives in tasks/loop.ts and is called from TasksDO's
 * /workflow/tasks/exec-tool endpoint.
 */

import { WEB_SEARCH_TOOL } from '../runtime/tavily';

export const TASKS_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'show_projects',
      description: 'The project board: every active project with step progress (n/m done), the next actionable steps, and staleness, plus loose one-off tasks. Call this first for open-ended questions ("where do my projects stand?", "what should I work on this weekend?") and for the weekly review.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'show_summary',
      description: 'Flat status summary: counts by status/priority, overdue items, ready and blocked tasks. Prefer show_projects for project-level questions; use this for quick status counts.',
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
      name: 'update_plan',
      description: "Save or update a project's living plan — a markdown document for design decisions, measurements, layout, and build sequence (e.g. a sprinkler system's manifold design + zone layout). Pass the COMPLETE merged document every time: read the current plan (get_task shows it), fold in what changed, never drop existing detail. Use sections like ## Design, ## Materials, ## Sequence, ## Decisions. Keep the plan and the project's steps in sync — when the sequence changes, update the subtasks too.",
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'The project (top-level task id, t_…).' },
          content: { type: 'string', description: 'Full merged plan as Markdown. Replaces the stored plan.' },
        },
        required: ['project_id', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_supplies',
      description: 'Maintain a project\'s supplies/shopping list (no prices — just what to buy). "add" items with qty + spec ("7x sprinkler head, adjustable 90° nozzle"; "3x 10ft 1in sch-40 PVC"). "bought" marks them acquired ("got the PVC"). "remove" drops mistakes. Call this whenever the user mentions materials a project needs or reports buying them.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'The project (top-level task id, t_…).' },
          action: { type: 'string', enum: ['add', 'bought', 'remove'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Item name, lowercase ("sprinkler head", "pvc pipe").' },
                qty: { type: 'string', description: 'e.g. "7", "3x 10ft sticks". Omit if unknown.' },
                spec: { type: 'string', description: 'Variant/spec that matters at the store: "adjustable 90° nozzle", "1in schedule 40".' },
                notes: { type: 'string', description: 'Optional: where to buy, alternatives.' },
              },
              required: ['name'],
            },
          },
        },
        required: ['project_id', 'action', 'items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'attach_file',
      description: 'File a stored file (f_…) to a project, with an optional note on what it is ("manifold layout sketch", "STL for the valve-box bracket"). Files arrive via Discord uploads — the message will say "[Attached file saved: f_… name]" — and sit in an inbox until you attach them. Infer the project from the caption/context; ask only if genuinely ambiguous. Also works to move a file between projects.',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'File id (f_…).' },
          project_id: { type: 'string', description: 'The project (top-level task id, t_…).' },
          note: { type: 'string', description: 'What this file is, in a few words.' },
        },
        required: ['file_id', 'project_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: "List stored files — for one project, or everything (including the inbox of unfiled uploads) when project_id is omitted.",
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Limit to one project. Omit for all files + inbox.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_file',
      description: 'Post a stored file back into this conversation as a Discord attachment ("send me the manifold sketch", "I need that STL"). Note: files over the server\'s upload cap (~10 MB) will fail to send — report the error if so.',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'File id (f_…).' },
        },
        required: ['file_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remove_file',
      description: 'Permanently delete a stored file (from storage and the index). Only on explicit user request.',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'File id (f_…).' },
        },
        required: ['file_id'],
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
  // Shared Tavily-backed search (executed centrally in AgentDOBase). Available
  // when a specific task needs a fact looked up; not central to task management.
  WEB_SEARCH_TOOL,
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
  /** Living plan document (markdown). Only meaningful on projects (top-level tasks). */
  plan: string | null;
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

/** A stored project file (bytes in R2; this is the index row).
 *  project_id NULL = inbox: uploaded but not yet filed to a project. */
export interface FileRow {
  id: string;
  project_id: string | null;
  filename: string;
  r2_key: string;
  content_type: string | null;
  size: number | null;
  note: string | null;
  created_at: number;
  [key: string]: SqlStorageValue;
}

/** One supplies/shopping-list row, always attached to a project. */
export interface SupplyRow {
  id: number;
  project_id: string;
  name: string;
  qty: string | null;
  spec: string | null;
  status: 'needed' | 'bought';
  notes: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}
