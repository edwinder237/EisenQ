"use client";

import { useState, useEffect, useRef, useCallback, useMemo, Fragment, type ReactNode } from "react";
import { isBlankStep, requiredStepsLeft, stepProgress } from "~/lib/checklist-steps";
import { LinkifiedText } from "~/components/LinkifiedText";
import { AssistantPanel, type AssistantSuggestion } from "~/components/AssistantPanel";
import {
  CircleDashed,
  CircleDot,
  ListChecks,
  Search,
  Sun,
  Moon,
  Settings,
  Plus,
  Trash2,
  Calendar,
  CheckCircle2,
  AlertCircle,
  X,
  CalendarDays,
  CalendarRange,
  CalendarPlus,
  Clock,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  GripVertical,
  ArrowRight,
  Share2,
  Download,
  Repeat,
  Edit3,
  Cloud,
  MapPin,
  Loader2,
  Copy,
  Star,
  ArrowLeftRight,
  Unlink,
  Link2,
  Info,
  Archive,
  Sparkles,
} from "lucide-react";
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  addMonths,
  subMonths,
  addWeeks,
  subWeeks,
  addYears,
  subYears,
  addDays,
  subDays,
  isToday,
  startOfDay,
  endOfDay
} from "date-fns";
import { format } from "date-fns";
import { cn } from "~/lib/utils";
import { addToCalendar } from "~/lib/calendar-export";
import toast, { Toaster } from "react-hot-toast";
import { UserButton, useUser } from "@clerk/nextjs";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAudioFeedback } from "~/hooks/useAudioFeedback";

type TaskQuadrant = "urgent-important" | "important-not-urgent" | "urgent-not-important" | "not-urgent-not-important";
type TaskPriority = "high" | "medium" | "low";
type TaskStatus = "pending" | "in-progress" | "completed";
type CalendarView = "day" | "week" | "month";

interface Task {
  _id: string;
  title: string;
  description?: string;
  quadrant: TaskQuadrant;
  priority: TaskPriority;
  status: TaskStatus;
  dueDate?: string;
  duration?: number;
  createdAt: string;
  updatedAt: string;
  parentTaskId?: string;
  linkedParentId?: string;
  goalId?: string;
  sortOrder?: number;
  archivedAt?: string;
  completedAt?: string;
  subtaskCount?: number;
  subtaskCompletedCount?: number;
  checklists?: TaskChecklist[];
}

// A reusable checklist copied onto a task. Distinct from ChecklistItem below,
// which is the daily/weekly routine habit — same word, unrelated feature.
interface TaskChecklistStep {
  id: string;
  text: string;
  order: number;
  done: boolean;
  doneAt?: string;
  optional?: boolean; // never blocks completion
  note?: string;      // read-only reference from Myndlist
}

interface TaskChecklist {
  id: string;
  sourceId: string | null;
  name: string;
  blockCompletion: boolean;
  order: number;
  steps: TaskChecklistStep[];
}

// A row in the Myndlist library (the reusable original, not an attached copy).
interface MyndlistTemplateStep {
  id: string;
  text: string;
  optional?: boolean;
  note?: string;
}

interface MyndlistTemplate {
  id: string;
  name: string;
  steps: MyndlistTemplateStep[];
  stepCount: number;
  usageCount: number;
  blockCompletion: boolean;
}

/** "12 steps · 2 optional" for a library row. */
function templateStepSummary(template: MyndlistTemplate): string {
  const optional = template.steps.filter((s) => s.optional).length;
  const steps = `${template.stepCount} step${template.stepCount === 1 ? "" : "s"}`;
  return optional ? `${steps} · ${optional} optional` : steps;
}

type GoalPeriodType = "week" | "month" | "year" | "custom";
type GoalStatus = "active" | "achieved" | "dropped";

interface Goal {
  _id: string;
  title: string;
  icon?: string;
  note?: string;
  periodType: GoalPeriodType;
  periodKey: string;
  startDate?: string;
  endDate?: string;
  status: GoalStatus;
  pinned?: boolean;
  parentGoalId?: string;
  createdAt: string;
  updatedAt: string;
}


type ChecklistFrequency = "daily" | "weekly";

interface ChecklistItem {
  _id: string;
  title: string;
  description?: string;
  frequency: ChecklistFrequency;
  daysOfWeek?: number[];
  completedDates: string[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface MaintenanceItem {
  _id: string;
  title: string;
  description?: string;
  intervalDays: number;
  lastCompletedDate?: string;
  nextDueDate: string;
}

interface PaymentLineItem {
  label: string;
  amount: number;
}

interface PaymentAccount {
  id: string;
  shortName: string;
  total: number;
  items: PaymentLineItem[];
}

interface PaymentsDueData {
  configured: boolean;
  date?: string;
  totalIncome?: number;
  finalBalance?: number;
  accounts?: PaymentAccount[];
  budgets?: PaymentLineItem[];
}

const INTERVAL_PRESETS = [
  { label: "Monthly", days: 30 },
  { label: "3 months", days: 90 },
  { label: "6 months", days: 180 },
  { label: "Yearly", days: 365 },
] as const;

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const WEATHER_CODE_MAP: Record<number, { label: string; icon: string }> = {
  0: { label: "Clear sky", icon: "sun" },
  1: { label: "Mostly clear", icon: "sun" },
  2: { label: "Partly cloudy", icon: "cloud" },
  3: { label: "Overcast", icon: "cloud" },
  45: { label: "Foggy", icon: "fog" },
  48: { label: "Rime fog", icon: "fog" },
  51: { label: "Light drizzle", icon: "drizzle" },
  53: { label: "Drizzle", icon: "drizzle" },
  55: { label: "Dense drizzle", icon: "drizzle" },
  61: { label: "Light rain", icon: "rain" },
  63: { label: "Rain", icon: "rain" },
  65: { label: "Heavy rain", icon: "rain" },
  71: { label: "Light snow", icon: "snow" },
  73: { label: "Snow", icon: "snow" },
  75: { label: "Heavy snow", icon: "snow" },
  77: { label: "Snow grains", icon: "snow" },
  80: { label: "Light showers", icon: "rain" },
  81: { label: "Showers", icon: "rain" },
  82: { label: "Heavy showers", icon: "rain" },
  85: { label: "Snow showers", icon: "snow" },
  86: { label: "Heavy snow showers", icon: "snow" },
  95: { label: "Thunderstorm", icon: "lightning" },
  96: { label: "Thunderstorm + hail", icon: "lightning" },
  99: { label: "Thunderstorm + heavy hail", icon: "lightning" },
};

function safeGetItem(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSetItem(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
function safeRemoveItem(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// Curated markers for goals. Emoji stay distinguishable at the small size used
// beside tasks in the matrix, where a monochrome icon set would not.
const GOAL_ICONS = [
  "🏃", "💪", "🧘", "🥗", "😴", "🩺",
  "💍", "❤️", "🏡", "👨‍👩‍👧", "✈️", "🌱",
  "💼", "📈", "🎯", "🧑‍💻", "📚", "✍️",
  "💰", "🏦", "📊", "🧠", "🎨", "⭐",
];

// A goal's marker. Falls back to a leading emoji already typed into the title,
// so goals written before icons existed still render one.
const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*)/u;
function goalIconOf(goal: { icon?: string; title: string } | undefined): string | undefined {
  if (!goal) return undefined;
  if (goal.icon?.trim()) return goal.icon;
  return LEADING_EMOJI.exec(goal.title)?.[1];
}

// Task editor: attribute "chips". A chip reads as filled when the attribute is
// set and as a dashed "+ Add" affordance when it isn't.
const CHIP_BASE = "inline-flex items-center gap-[7px] text-[13px] rounded-full px-[13px] py-[6px] outline-none transition-colors hover:brightness-[0.97]";
const CHIP_SET = { background: "var(--chip)", border: "1px solid var(--field-bd)", color: "var(--ink2)" };
const CHIP_UNSET = { border: "1px dashed var(--check-bd)", color: "var(--muted5)", background: "transparent" };
const MENU_CLS = "min-w-[196px] max-w-[300px] rounded-[12px] p-1.5 shadow-lg z-[200] bg-[var(--drawer)] border border-[var(--drawer-bd)]";
const MENU_ITEM = "flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer outline-none hover:bg-[var(--hover)] text-[var(--ink2)]";

const QUADRANT_SHORT: Record<TaskQuadrant, string> = {
  "urgent-important": "Urgent & important",
  "important-not-urgent": "Important, not urgent",
  "urgent-not-important": "Urgent, not important",
  "not-urgent-not-important": "Not urgent or important",
};
const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  high: { label: "High", color: "var(--q-do-first)" },
  medium: { label: "Medium", color: "var(--q-schedule)" },
  low: { label: "Low", color: "var(--q-eliminate)" },
};
const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240, 480];

const SETTINGS_SECTIONS = [
  { id: "tasks", label: "Tasks" },
  { id: "greeting", label: "Greeting" },
  { id: "calendar", label: "Calendar" },
  { id: "integrations", label: "Integrations" },
] as const;
type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

// "yyyy-MM-dd" → local Date (avoids the UTC shift of new Date("2026-07-28"))
function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

// Today in the browser's own timezone. Never toISOString() for this: that
// converts to UTC and hands back yesterday for anyone west of Greenwich.
function todayYmd(): string {
  return format(new Date(), "yyyy-MM-dd");
}

// Steps a "yyyy-MM-dd" by whole days without leaving local calendar time.
// Anchored at noon so a DST jump can never push the result into the adjacent
// day; setDate handles month and year rollover on its own.
function shiftYmd(s: string, days: number): string {
  const d = parseYmd(s);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return format(d, "yyyy-MM-dd");
}

// Per-quadrant "next action" choice: a task id pins that task as the headline,
// NEXT_ACTION_CLEARED leaves the slot deliberately empty. Absent = auto-pick.
const NEXT_ACTION_CLEARED = "__none__";
const NEXT_ACTION_KEY = "eisenq-next-action";

// Matrix rows only travel up and down their own list.
const lockToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

type SortableRowHandle = Pick<ReturnType<typeof useSortable>, "listeners" | "setActivatorNodeRef" | "isDragging">;

// One "Up next" row. The grip inside is the drag handle; rows that follow their
// due date (or are done) render the same but stay put.
function SortableTaskRow({ id, disabled, children }: {
  id: string;
  disabled: boolean;
  children: (handle: SortableRowHandle) => ReactNode;
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled });
  return (
    <div ref={setNodeRef} className="group flex items-center gap-[11px] rounded-[8px]"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        position: "relative",
        zIndex: isDragging ? 10 : undefined,
        background: isDragging ? "var(--surface)" : undefined,
        boxShadow: isDragging ? "0 0 0 6px var(--surface), 0 10px 24px -10px rgba(0,0,0,0.45)" : undefined,
      }}>
      {children({ listeners, setActivatorNodeRef, isDragging })}
    </div>
  );
}

export default function HomePage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [nextActionChoice, setNextActionChoice] = useState<Partial<Record<TaskQuadrant, string>>>({});
  // The "Up next" row whose grip menu is open. Controlled so the grip opens it
  // on click and stays free to start a drag on press.
  const [rowMenuTaskId, setRowMenuTaskId] = useState<string | null>(null);
  // "Nest under task" picker (searchable + quadrant-filterable)
  const [nestPickerOpen, setNestPickerOpen] = useState(false);
  const [nestSearch, setNestSearch] = useState("");
  const [nestQuadrantFilter, setNestQuadrantFilter] = useState<TaskQuadrant | "all">("all");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [darkMode, setDarkMode] = useState<boolean | null>(null);
  // Use dark mode as default during SSR/initial render to prevent flash
  const isDarkMode = darkMode ?? true;
  const { user } = useUser();
  const { playCompletionSound, playUncompleteSound } = useAudioFeedback();
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [taskOperationLoading, setTaskOperationLoading] = useState<Record<string, boolean>>({});
  const [quadrantLoading, setQuadrantLoading] = useState<Record<TaskQuadrant, boolean>>({
    "urgent-important": false,
    "important-not-urgent": false,
    "urgent-not-important": false,
    "not-urgent-not-important": false,
  });
  const [formData, setFormData] = useState<{
    title: string;
    description: string;
    quadrant: TaskQuadrant;
    priority: TaskPriority;
    dueDate: string;
    dueTime: string;
    duration: number | "";
    goalId: string;
    linkedParentId: string;
  }>({
    title: "",
    description: "",
    quadrant: "urgent-important",
    priority: "medium",
    dueDate: "",
    dueTime: "12:00",
    duration: "",
    goalId: "",
    linkedParentId: ""
  });
  const [quickTaskInputs, setQuickTaskInputs] = useState<Record<TaskQuadrant, string>>({
    "urgent-important": "",
    "important-not-urgent": "",
    "urgent-not-important": "",
    "not-urgent-not-important": ""
  });

  // Calendar state
  const [calendarView, setCalendarView] = useState<CalendarView>("day");
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [isCalendarDrawerOpen, setIsCalendarDrawerOpen] = useState(false);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [isCalendarTaskModalOpen, setIsCalendarTaskModalOpen] = useState(false);
  const [editingCalendarTask, setEditingCalendarTask] = useState<Task | null>(null);
  const [calendarTaskForm, setCalendarTaskForm] = useState({
    title: "",
    description: "",
    time: "09:00",
    duration: 30,
    quadrant: "urgent-important" as TaskQuadrant,
    priority: "medium" as TaskPriority,
    date: new Date(),
    goalId: "",
  });

  // Stats drawer state

  // Settings state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState("");
  // Claude key for the AI assistant (experimental). Server-only use; never cached in localStorage.
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [draftAnthropicKey, setDraftAnthropicKey] = useState("");
  const [autoArchiveCompleted, setAutoArchiveCompleted] = useState(false);
  const [draftAutoArchive, setDraftAutoArchive] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("tasks");
  const [financeApiUrl, setFinanceApiUrl] = useState("");
  const [financeApiKey, setFinanceApiKey] = useState("");
  const [draftFinanceUrl, setDraftFinanceUrl] = useState("");
  const [draftFinanceKey, setDraftFinanceKey] = useState("");
  const [financeUserId, setFinanceUserId] = useState("");
  const [draftFinanceUserId, setDraftFinanceUserId] = useState("");
  const [financeTesting, setFinanceTesting] = useState(false);
  const [financeTestResult, setFinanceTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  // Myndlist: the reusable-checklist library lives in a separate app the user owns.
  const [myndlistApiUrl, setMyndlistApiUrl] = useState("");
  const [myndlistApiKey, setMyndlistApiKey] = useState("");
  const [draftMyndlistUrl, setDraftMyndlistUrl] = useState("");
  const [draftMyndlistKey, setDraftMyndlistKey] = useState("");
  const [myndlistTesting, setMyndlistTesting] = useState(false);
  const [myndlistTestResult, setMyndlistTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // ===== Checklist library (Myndlist) and attached instances =====
  // Instances live on the Task document, so `tasks` and `editingTask` are the
  // only stores for them — there is no separate instance cache to drift.
  const [myndlistDrawerOpen, setMyndlistDrawerOpen] = useState(false);
  const [myndlistTemplates, setMyndlistTemplates] = useState<MyndlistTemplate[]>([]);
  const [myndlistConfigured, setMyndlistConfigured] = useState(true);
  const [myndlistLoading, setMyndlistLoading] = useState(false);
  const [myndlistError, setMyndlistError] = useState("");
  const [myndlistFetchedAt, setMyndlistFetchedAt] = useState(0);
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null);
  // Draft steps keep their Myndlist id (new ones get a "new-" id) so saving can update items in place.
  const [templateDraft, setTemplateDraft] = useState<{ name: string; blockCompletion: boolean; steps: MyndlistTemplateStep[] } | null>(null);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [newTemplateStep, setNewTemplateStep] = useState("");

  const [expandedTaskChecklistIds, setExpandedTaskChecklistIds] = useState<Set<string>>(new Set());
  const [attachPickerOpen, setAttachPickerOpen] = useState(false);
  const [attachSearch, setAttachSearch] = useState("");
  const [attachBusyId, setAttachBusyId] = useState<string | null>(null);
  const [newChecklistStep, setNewChecklistStep] = useState<Record<string, string>>({});
  const [gateHintTaskId, setGateHintTaskId] = useState<string | null>(null);

  // Ticking a step is optimistic and the write is coalesced per checklist.
  // Refs, not state: a state-held timer id is stale inside the timeout closure,
  // and re-rendering this component on every tick is the dominant cost.
  const stepFlushTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingStepOps = useRef<Map<string, {
    taskId: string;
    checklistId: string;
    steps: Map<string, boolean>;
    snapshot: TaskChecklistStep[];
  }>>(new Map());
  const [archivedTasks, setArchivedTasks] = useState<Task[]>([]);
  const [settingsKeyInput, setSettingsKeyInput] = useState("");
  const [icalUrls, setIcalUrls] = useState<string[]>([]);
  const [settingsIcalInput, setSettingsIcalInput] = useState("");
  const [settingsIcalError, setSettingsIcalError] = useState("");
  // Settings modal edits are staged as drafts and applied together on Save
  const [draftIcalUrls, setDraftIcalUrls] = useState<string[]>([]);

  // Calendar feed state
  interface CalendarEvent { id: string; title: string; start: string; end: string; allDay: boolean; location?: string; }
  interface CalendarGroup { name: string; events: CalendarEvent[]; error?: boolean; }
  const [calendarGroups, setCalendarGroups] = useState<CalendarGroup[]>([]);
  const [calendarLoading, setCalendarLoading] = useState(false);
  // Flattened iCal events (with source calendar name) for the viewed Task Planning range
  type PlanningEvent = CalendarEvent & { calendar: string };
  const [planningEvents, setPlanningEvents] = useState<PlanningEvent[]>([]);
  const [planningLoading, setPlanningLoading] = useState(false);

  // Weather widget state
  const [weatherLocation, setWeatherLocation] = useState("Montreal, Quebec");
  const [weatherData, setWeatherData] = useState<{
    temp: number;
    feelsLike: number;
    weatherCode: number;
    hourly: Array<{ time: string; temp: number; weatherCode: number }>;
  } | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState("");
  const [locationInput, setLocationInput] = useState("");
  const [clothingSuggestion, setClothingSuggestion] = useState("");
  const [clothingLoading, setClothingLoading] = useState(false);

  // Checklist state
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [showChecklistForm, setShowChecklistForm] = useState(false);
  const [checklistTab, setChecklistTab] = useState<"today" | "all" | "maintenance">("today");
  const [maintenanceItems, setMaintenanceItems] = useState<MaintenanceItem[]>([]);
  const [showMaintenanceForm, setShowMaintenanceForm] = useState(false);
  const [editingMaintenanceItem, setEditingMaintenanceItem] = useState<MaintenanceItem | null>(null);
  const [maintenanceFormData, setMaintenanceFormData] = useState({ title: "", description: "", intervalDays: 90, nextDueDate: "" });
  const [paymentsData, setPaymentsData] = useState<PaymentsDueData | null>(null);
  const [paymentsError, setPaymentsError] = useState(false);
  // Which day the payments bar is showing. Always a local calendar date.
  const [paymentsDate, setPaymentsDate] = useState<string>(() => todayYmd());
  const [expandedPaymentAccounts, setExpandedPaymentAccounts] = useState<Set<string>>(new Set());
  const [paidPaymentAccounts, setPaidPaymentAccounts] = useState<Set<string>>(new Set());
  const [editingChecklistItem, setEditingChecklistItem] = useState<ChecklistItem | null>(null);
  const [checklistFormData, setChecklistFormData] = useState({
    title: "",
    description: "",
    frequency: "daily" as ChecklistFrequency,
    daysOfWeek: [] as number[],
  });

  // Calm Editorial redesign drawers
  const [routineDrawerOpen, setRoutineDrawerOpen] = useState(false);
  const [paymentsDrawerOpen, setPaymentsDrawerOpen] = useState(false);

  // Goals state
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalsLoading, setGoalsLoading] = useState(false);
  const [isGoalsExpanded, setIsGoalsExpanded] = useState(false);
  const [goalsPanelPeriodType, setGoalsPanelPeriodType] = useState<GoalPeriodType>("week");
  const [showUnfinishedGoals, setShowUnfinishedGoals] = useState(false);
  const [goalsPanelDate, setGoalsPanelDate] = useState(new Date());
  const [showGoalForm, setShowGoalForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);
  const [goalFormData, setGoalFormData] = useState({ title: "", icon: "", note: "", parentGoalId: "", startDate: "", endDate: "" });

  // Subtask state (for edit modal)
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [newSubtaskTitle, setNewSubtaskTitle] = useState("");
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState("");

  // Helper to extract time from dueDate
  const getTimeFromDate = (dateString: string) => {
    return format(new Date(dateString), "HH:mm");
  };

  // Calendar task handlers
  const openCalendarTaskForEdit = (task: Task) => {
    setEditingCalendarTask(task);
    const taskDate = task.dueDate ? new Date(task.dueDate) : new Date();
    setCalendarTaskForm({
      title: task.title,
      description: task.description ?? "",
      time: task.dueDate ? getTimeFromDate(task.dueDate) : "09:00",
      duration: task.duration ?? 30,
      quadrant: task.quadrant,
      priority: task.priority,
      date: taskDate,
      goalId: task.goalId ?? "",
    });
    setIsCalendarTaskModalOpen(true);
  };

  const openCalendarTaskForCreate = () => {
    setEditingCalendarTask(null);
    setCalendarTaskForm({
      title: "",
      description: "",
      time: "09:00",
      duration: 30,
      quadrant: "important-not-urgent",
      priority: "medium",
      date: selectedDate,
      goalId: "",
    });
    setIsCalendarTaskModalOpen(true);
  };

  const closeCalendarTaskModal = () => {
    setIsCalendarTaskModalOpen(false);
    setEditingCalendarTask(null);
  };

  const handleSaveCalendarTask = async () => {
    if (!calendarTaskForm.title.trim()) {
      toast.error("Please enter a task title");
      return;
    }

    // Combine date and time into full datetime (using local timezone)
    const dateObj = calendarTaskForm.date;
    const [hours, minutes] = calendarTaskForm.time.split(':');
    const fullDateTime = new Date(
      dateObj.getFullYear(),
      dateObj.getMonth(),
      dateObj.getDate(),
      parseInt(hours ?? "9"),
      parseInt(minutes ?? "0"),
      0,
      0
    );

    try {
      if (editingCalendarTask) {
        // Update existing task
        const response = await fetch("/api/tasks", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            _id: editingCalendarTask._id,
            title: calendarTaskForm.title,
            description: calendarTaskForm.description,
            quadrant: calendarTaskForm.quadrant,
            priority: calendarTaskForm.priority,
            dueDate: fullDateTime.toISOString(),
            duration: calendarTaskForm.duration,
            goalId: calendarTaskForm.goalId || null,
          })
        });

        if (response.ok) {
          const updatedTask = await response.json() as Task;
          setTasks(prev => prev.map(task =>
            task._id === updatedTask._id ? updatedTask : task
          ));
          toast.success("Task updated successfully!");
        } else {
          toast.error("Failed to update task");
        }
      } else {
        // Create new task
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: calendarTaskForm.title,
            description: calendarTaskForm.description,
            quadrant: calendarTaskForm.quadrant,
            priority: calendarTaskForm.priority,
            dueDate: fullDateTime.toISOString(),
            duration: calendarTaskForm.duration,
            goalId: calendarTaskForm.goalId || undefined,
          })
        });

        if (response.ok) {
          const newTask = await response.json() as Task;
          setTasks(prev => [...prev, newTask]);
          toast.success("Task created successfully!");
        } else {
          toast.error("Failed to create task");
        }
      }
      closeCalendarTaskModal();
    } catch {
      toast.error("Error saving task");
    }
  };

  const handleDeleteCalendarTask = async () => {
    if (editingCalendarTask) {
      try {
        const response = await fetch(`/api/tasks?id=${editingCalendarTask._id}`, {
          method: "DELETE"
        });

        if (response.ok) {
          setTasks(prev => prev.filter(task => task._id !== editingCalendarTask._id));
          toast.success("Task deleted successfully!");
          closeCalendarTaskModal();
        } else {
          toast.error("Failed to delete task");
        }
      } catch {
        toast.error("Error deleting task");
      }
    }
  };

  const handleMoveToTomorrow = async () => {
    if (!editingCalendarTask) return;

    // Get tomorrow's date with the same time
    const currentDate = editingCalendarTask.dueDate
      ? new Date(editingCalendarTask.dueDate)
      : new Date();
    const tomorrow = addDays(currentDate, 1);

    try {
      const response = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: editingCalendarTask._id,
          dueDate: tomorrow.toISOString(),
        })
      });

      if (response.ok) {
        const updatedTask = await response.json() as Task;
        setTasks(prev => prev.map(task =>
          task._id === updatedTask._id ? updatedTask : task
        ));
        // Update the form to reflect the new date
        setCalendarTaskForm(prev => ({
          ...prev,
          date: tomorrow
        }));
        toast.success("Task moved to tomorrow!");
      } else {
        toast.error("Failed to move task");
      }
    } catch {
      toast.error("Error moving task");
    }
  };

  // Quick-sync a scheduled task to an external calendar, straight from its card.
  // Reschedule an overdue task to tomorrow, keeping its original time of day.
  // Helper functions for calendar
  const getTasksForDate = (date: Date) => {
    return tasks.filter(task => {
      if (!task.dueDate) return false;
      const taskDate = new Date(task.dueDate);
      return isSameDay(taskDate, date);
    });
  };

  const getEventsForDate = (date: Date) => {
    const dayStart = startOfDay(date).getTime();
    const dayEnd = endOfDay(date).getTime();
    return planningEvents
      .filter(ev => {
        const s = new Date(ev.start).getTime();
        const e = new Date(ev.end).getTime();
        return s <= dayEnd && e >= dayStart;
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  };

  const getWeekDays = () => {
    const start = startOfWeek(selectedDate, { weekStartsOn: 0 });
    const end = endOfWeek(selectedDate, { weekStartsOn: 0 });
    return eachDayOfInterval({ start, end });
  };

  const getMonthDays = () => {
    const start = startOfMonth(selectedDate);
    const end = endOfMonth(selectedDate);
    const monthDays = eachDayOfInterval({ start, end });

    // Add padding days from previous month
    const startDay = start.getDay();
    const paddingStart = startDay > 0
      ? eachDayOfInterval({ start: subDays(start, startDay), end: subDays(start, 1) })
      : [];

    // Add padding days for next month to complete the grid
    const totalDays = paddingStart.length + monthDays.length;
    const paddingEnd = totalDays % 7 !== 0
      ? eachDayOfInterval({ start: addDays(end, 1), end: addDays(end, 7 - (totalDays % 7)) })
      : [];

    return [...paddingStart, ...monthDays, ...paddingEnd];
  };

  const navigateCalendar = (direction: "prev" | "next") => {
    if (calendarView === "day") {
      setSelectedDate(direction === "prev" ? subDays(selectedDate, 1) : addDays(selectedDate, 1));
    } else if (calendarView === "week") {
      setSelectedDate(direction === "prev" ? subWeeks(selectedDate, 1) : addWeeks(selectedDate, 1));
    } else {
      setSelectedDate(direction === "prev" ? subMonths(selectedDate, 1) : addMonths(selectedDate, 1));
    }
  };

  useEffect(() => {
    void fetchTasks();
    void fetchGoals();
    void fetchChecklistItems();
    void fetchMaintenanceItems();
  }, []);

  // Reload whenever the viewed day changes, and swap in that day's paid set so
  // the ticks belong to the date on screen rather than to today.
  useEffect(() => {
    void fetchPaymentsDue(paymentsDate);
    try {
      const stored = localStorage.getItem(`eisenq-payments-paid-${paymentsDate}`);
      setPaidPaymentAccounts(stored ? new Set(JSON.parse(stored) as string[]) : new Set());
    } catch {
      setPaidPaymentAccounts(new Set());
    }
  }, [paymentsDate]);

  // Initialize dark mode from localStorage or system preference
  useEffect(() => {
    const stored = localStorage.getItem("eisenq-dark-mode");
    if (stored !== null) {
      setDarkMode(stored === "true");
    } else {
      // Use system preference
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      setDarkMode(mediaQuery.matches);

      // Listen for system preference changes
      const handler = (e: MediaQueryListEvent) => {
        // Only update if user hasn't set a preference
        if (localStorage.getItem("eisenq-dark-mode") === null) {
          setDarkMode(e.matches);
        }
      };
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, []);


  // Initialize weather location, Gemini API key, and iCal URLs.
  // localStorage is a fast cache; the encrypted DB (via /api/settings) is the source of truth.
  useEffect(() => {
    const stored = safeGetItem("eisenq-weather-location");
    if (stored) setWeatherLocation(stored);
    const storedKey = safeGetItem("eisenq-gemini-api-key");
    if (storedKey) setGeminiApiKey(storedKey);
    const storedUrls = safeGetItem("eisenq-ical-urls");
    if (storedUrls) {
      try { setIcalUrls(JSON.parse(storedUrls) as string[]); } catch { /* ignore */ }
    }
    const storedNextAction = safeGetItem(NEXT_ACTION_KEY);
    if (storedNextAction) {
      try { setNextActionChoice(JSON.parse(storedNextAction) as Partial<Record<TaskQuadrant, string>>); } catch { /* ignore */ }
    }

    // Hydrate from the server and refresh the cache.
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const data = (await res.json()) as { geminiApiKey?: string; icalUrls?: string[]; autoArchiveCompleted?: boolean; financeApiUrl?: string; financeApiKey?: string; financeUserId?: string; myndlistApiUrl?: string; myndlistApiKey?: string; anthropicApiKey?: string };
        if (typeof data.anthropicApiKey === "string") {
          setAnthropicApiKey(data.anthropicApiKey);
          setDraftAnthropicKey(data.anthropicApiKey);
        }
        if (typeof data.geminiApiKey === "string") {
          setGeminiApiKey(data.geminiApiKey);
          if (data.geminiApiKey) safeSetItem("eisenq-gemini-api-key", data.geminiApiKey);
          else safeRemoveItem("eisenq-gemini-api-key");
        }
        if (typeof data.autoArchiveCompleted === "boolean") {
          setAutoArchiveCompleted(data.autoArchiveCompleted);
          setDraftAutoArchive(data.autoArchiveCompleted);
        }
        if (typeof data.financeApiUrl === "string") {
          setFinanceApiUrl(data.financeApiUrl);
          setDraftFinanceUrl(data.financeApiUrl);
        }
        if (typeof data.financeApiKey === "string") {
          setFinanceApiKey(data.financeApiKey);
          setDraftFinanceKey(data.financeApiKey);
        }
        if (typeof data.myndlistApiUrl === "string") {
          setMyndlistApiUrl(data.myndlistApiUrl);
          setDraftMyndlistUrl(data.myndlistApiUrl);
        }
        if (typeof data.myndlistApiKey === "string") {
          setMyndlistApiKey(data.myndlistApiKey);
          setDraftMyndlistKey(data.myndlistApiKey);
        }
        if (typeof data.financeUserId === "string") {
          setFinanceUserId(data.financeUserId);
          setDraftFinanceUserId(data.financeUserId);
        }
        if (Array.isArray(data.icalUrls)) {
          setIcalUrls(data.icalUrls);
          safeSetItem("eisenq-ical-urls", JSON.stringify(data.icalUrls));
        }
      } catch { /* offline — keep cached values */ }
    })();
  }, []);

  // Persist settings to the encrypted DB. localStorage cache is updated by callers
  // for instant reads; this fire-and-forget call keeps the server in sync.
  const persistSettings = useCallback((partial: { geminiApiKey?: string; icalUrls?: string[]; autoArchiveCompleted?: boolean; financeApiUrl?: string; financeApiKey?: string; financeUserId?: string; myndlistApiUrl?: string; myndlistApiKey?: string; anthropicApiKey?: string }) => {
    void fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    }).catch(() => { /* ignore — cache still holds the value */ });
  }, []);

  // Runs one real request against whatever is typed in the Integrations form,
  // so credentials can be checked before saving them.
  const handleTestFinanceConnection = useCallback(async () => {
    setFinanceTesting(true);
    setFinanceTestResult(null);
    try {
      const res = await fetch("/api/payments/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          financeApiUrl: draftFinanceUrl.trim(),
          financeApiKey: draftFinanceKey.trim(),
          financeUserId: draftFinanceUserId.trim(),
          date: format(new Date(), "yyyy-MM-dd"),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      setFinanceTestResult({
        ok: data.ok === true,
        message: data.message ?? data.error ?? "The test could not be run.",
      });
    } catch {
      setFinanceTestResult({ ok: false, message: "The test could not be run. Check your connection." });
    } finally {
      setFinanceTesting(false);
    }
  }, [draftFinanceUrl, draftFinanceKey, draftFinanceUserId]);

  // Runs one real request against whatever is typed in the Myndlist fields,
  // so a key can be checked before saving it.
  const handleTestMyndlistConnection = useCallback(async () => {
    setMyndlistTesting(true);
    setMyndlistTestResult(null);
    try {
      const res = await fetch("/api/myndlist/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          myndlistApiUrl: draftMyndlistUrl.trim(),
          myndlistApiKey: draftMyndlistKey.trim(),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      setMyndlistTestResult({
        ok: data.ok === true,
        message: data.message ?? data.error ?? "The test could not be run.",
      });
    } catch {
      setMyndlistTestResult({ ok: false, message: "The test could not be run. Check your connection." });
    } finally {
      setMyndlistTesting(false);
    }
  }, [draftMyndlistUrl, draftMyndlistKey]);

  // ===== Checklist library =====
  // Fetched lazily, never on mount: a user who has not connected Myndlist should
  // not see a failed request just for loading the dashboard.
  const fetchMyndlistTemplates = useCallback(async (force = false) => {
    if (!force && myndlistFetchedAt && Date.now() - myndlistFetchedAt < 60_000) return;
    setMyndlistLoading(true);
    setMyndlistError("");
    try {
      const res = await fetch("/api/myndlist/checklists");
      const data = (await res.json()) as { configured?: boolean; templates?: MyndlistTemplate[]; error?: string };
      if (!res.ok) {
        setMyndlistError(data.error ?? "Couldn't load your checklists.");
        return;
      }
      setMyndlistConfigured(data.configured !== false);
      setMyndlistTemplates(data.templates ?? []);
      setMyndlistFetchedAt(Date.now());
    } catch {
      setMyndlistError("Couldn't reach the checklist library.");
    } finally {
      setMyndlistLoading(false);
    }
  }, [myndlistFetchedAt]);

  const openChecklistLibrary = useCallback((templateId?: string) => {
    setMyndlistDrawerOpen(true);
    setExpandedTemplateId(templateId ?? null);
    setTemplateDraft(null);
    void fetchMyndlistTemplates();
  }, [fetchMyndlistTemplates]);

  const closeChecklistLibrary = useCallback(() => {
    setMyndlistDrawerOpen(false);
    setExpandedTemplateId(null);
    setTemplateDraft(null);
    setNewTemplateStep("");
  }, []);

  const startEditTemplate = (template: MyndlistTemplate) => {
    setExpandedTemplateId(template.id);
    setTemplateDraft({
      name: template.name,
      blockCompletion: template.blockCompletion,
      steps: template.steps.map((s) => ({ ...s })),
    });
    setNewTemplateStep("");
  };

  const handleCreateTemplate = async (name: string, steps: string[] = []) => {
    setTemplateSaving(true);
    try {
      const res = await fetch("/api/myndlist/checklists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, steps }),
      });
      const data = (await res.json()) as { template?: MyndlistTemplate; error?: string };
      if (!res.ok || !data.template) {
        toast.error(data.error ?? "Couldn't create the checklist");
        return null;
      }
      setMyndlistTemplates((prev) => [data.template!, ...prev]);
      return data.template;
    } catch {
      toast.error("Couldn't create the checklist");
      return null;
    } finally {
      setTemplateSaving(false);
    }
  };

  const handleSaveTemplate = async (templateId: string) => {
    if (!templateDraft) return;
    setTemplateSaving(true);
    try {
      const res = await fetch(`/api/myndlist/checklists/${templateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: templateDraft.name.trim() || "Untitled checklist",
          steps: templateDraft.steps
            .filter((s) => s.text.trim())
            .map((s) => ({
              ...(s.id.startsWith("new-") ? {} : { id: s.id }),
              text: s.text,
              optional: Boolean(s.optional),
            })),
          blockCompletion: templateDraft.blockCompletion,
        }),
      });
      const data = (await res.json()) as { template?: MyndlistTemplate; error?: string };
      if (!res.ok || !data.template) {
        toast.error(data.error ?? "Couldn't save the checklist");
        return;
      }
      const saved = data.template;
      setMyndlistTemplates((prev) => prev.map((t) => (t.id === templateId ? { ...saved, usageCount: t.usageCount } : t)));
      setExpandedTemplateId(null);
      setTemplateDraft(null);
    } catch {
      toast.error("Couldn't save the checklist");
    } finally {
      setTemplateSaving(false);
    }
  };

  const handleDeleteTemplate = async (templateId: string) => {
    try {
      const res = await fetch(`/api/myndlist/checklists/${templateId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        toast.error(data.error ?? "Couldn't delete the checklist");
        return;
      }
      setMyndlistTemplates((prev) => prev.filter((t) => t.id !== templateId));
      setExpandedTemplateId(null);
      setTemplateDraft(null);
      // Copies already attached to tasks survive on purpose; they just lose the
      // link back. Reload so their menus reflect that.
      void fetchTasks();
    } catch {
      toast.error("Couldn't delete the checklist");
    }
  };

  // Whether the Settings drafts differ from the applied values
  const settingsDirty =
    locationInput.trim() !== weatherLocation ||
    settingsKeyInput.trim() !== geminiApiKey ||
    draftAnthropicKey.trim() !== anthropicApiKey ||
    draftIcalUrls.length !== icalUrls.length ||
    draftIcalUrls.some((u, i) => u !== icalUrls[i]) ||
    draftAutoArchive !== autoArchiveCompleted ||
    draftFinanceUrl.trim() !== financeApiUrl ||
    draftFinanceKey.trim() !== financeApiKey ||
    draftMyndlistUrl.trim() !== myndlistApiUrl ||
    draftMyndlistKey.trim() !== myndlistApiKey ||
    draftFinanceUserId.trim() !== financeUserId;

  // Apply all staged Settings drafts at once
  const handleSaveSettings = () => {
    const loc = locationInput.trim();
    if (loc && loc !== weatherLocation) {
      setWeatherLocation(loc);
      safeSetItem("eisenq-weather-location", loc);
    }
    const key = settingsKeyInput.trim();
    if (key !== geminiApiKey) {
      if (key) {
        setGeminiApiKey(key);
        safeSetItem("eisenq-gemini-api-key", key);
        persistSettings({ geminiApiKey: key });
      } else {
        setGeminiApiKey("");
        safeRemoveItem("eisenq-gemini-api-key");
        persistSettings({ geminiApiKey: "" });
        setClothingSuggestion("");
      }
    }
    const aKey = draftAnthropicKey.trim();
    if (aKey !== anthropicApiKey) {
      setAnthropicApiKey(aKey);
      persistSettings({ anthropicApiKey: aKey });
    }
    const urlsChanged =
      draftIcalUrls.length !== icalUrls.length || draftIcalUrls.some((u, i) => u !== icalUrls[i]);
    if (urlsChanged) {
      setIcalUrls(draftIcalUrls);
      safeSetItem("eisenq-ical-urls", JSON.stringify(draftIcalUrls));
      persistSettings({ icalUrls: draftIcalUrls });
      if (!draftIcalUrls.length) setCalendarGroups([]);
    }
    if (draftAutoArchive !== autoArchiveCompleted) {
      setAutoArchiveCompleted(draftAutoArchive);
      persistSettings({ autoArchiveCompleted: draftAutoArchive });
    }
    const fUrl = draftFinanceUrl.trim();
    const fKey = draftFinanceKey.trim();
    const fUid = draftFinanceUserId.trim();
    if (fUrl !== financeApiUrl || fKey !== financeApiKey || fUid !== financeUserId) {
      setFinanceApiUrl(fUrl);
      setFinanceApiKey(fKey);
      setFinanceUserId(fUid);
      persistSettings({ financeApiUrl: fUrl, financeApiKey: fKey, financeUserId: fUid });
      // The day-ends strip is driven by this endpoint, so refresh it once saved.
      setTimeout(() => void fetchPaymentsDue(paymentsDate), 400);
    }
    const mUrl = draftMyndlistUrl.trim();
    const mKey = draftMyndlistKey.trim();
    if (mUrl !== myndlistApiUrl || mKey !== myndlistApiKey) {
      setMyndlistApiUrl(mUrl);
      setMyndlistApiKey(mKey);
      persistSettings({ myndlistApiUrl: mUrl, myndlistApiKey: mKey });
      // The library is fetched lazily, so just drop the cache; the next open refetches.
      setMyndlistTemplates([]);
      setMyndlistFetchedAt(0);
    }
    setSettingsIcalInput("");
    setSettingsIcalError("");
    setIsSettingsOpen(false);
  };

  // Stage a new iCal feed into the draft list (validation + dedup)
  const addDraftIcalUrl = () => {
    const trimmed = settingsIcalInput.trim();
    if (!trimmed) return;
    try {
      new URL(trimmed);
    } catch {
      setSettingsIcalError("Enter a valid URL.");
      return;
    }
    if (draftIcalUrls.includes(trimmed)) {
      setSettingsIcalError("This URL is already added.");
      return;
    }
    setDraftIcalUrls([...draftIcalUrls, trimmed]);
    setSettingsIcalInput("");
    setSettingsIcalError("");
  };

  // Lock body scroll when any modal/drawer is open
  useEffect(() => {
    const isAnyModalOpen = isModalOpen || isInfoModalOpen || isCalendarDrawerOpen || isCalendarTaskModalOpen || routineDrawerOpen || isGoalsExpanded || paymentsDrawerOpen || myndlistDrawerOpen;

    if (isAnyModalOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }

    return () => {
      document.body.style.overflow = '';
    };
  }, [isModalOpen, isInfoModalOpen, isCalendarDrawerOpen, isCalendarTaskModalOpen, routineDrawerOpen, isGoalsExpanded, paymentsDrawerOpen, myndlistDrawerOpen]);

  useEffect(() => {
    const onLeave = () => { void flushAllStepOps(); };
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("beforeunload", onLeave);
      void flushAllStepOps();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchTasks = async () => {
    try {
      setIsLoading(true);
      const response = await fetch("/api/tasks");
      if (response.ok) {
        const data = await response.json() as Task[];
        setTasks(data);
      } else {
        toast.error("Failed to fetch tasks");
      }
    } catch {
      toast.error("Error loading tasks");
    } finally {
      setIsLoading(false);
    }
  };

  // Weather functions
  const lastWeatherHashRef = useRef("");
  const clothingCacheRef = useRef<Map<string, string>>(new Map());
  const WEATHER_CACHE_MS = 30 * 60 * 1000; // 30 minutes
  const WEATHER_CACHE_KEY = "eisenq-weather-cache";

  const getWeatherCache = () => {
    try {
      const raw = localStorage.getItem(WEATHER_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as { city: string; data: NonNullable<typeof weatherData>; fetchedAt: number };
    } catch { return null; }
  };

  const setWeatherCache = (city: string, data: NonNullable<typeof weatherData>) => {
    safeSetItem(WEATHER_CACHE_KEY, JSON.stringify({ city, data, fetchedAt: Date.now() }));
  };

  const fetchWeather = useCallback(async (city: string, signal?: AbortSignal, forceRefresh = false) => {
    // Check localStorage cache: same city + within 30 min → skip fetch
    if (!forceRefresh) {
      const cache = getWeatherCache();
      if (cache && cache.city === city && Date.now() - cache.fetchedAt < WEATHER_CACHE_MS) {
        setWeatherData(cache.data);
        setWeatherError("");
        setWeatherLoading(false);
        return;
      }
    }

    setWeatherLoading(true);
    setWeatherError("");
    try {
      const res = await fetch(`/api/weather?city=${encodeURIComponent(city)}`, { signal });
      if (!res.ok) {
        const errData = (await res.json().catch(() => null)) as { error?: string } | null;
        setWeatherError(errData?.error ?? "Could not load weather");
        return;
      }
      const data = (await res.json()) as {
        temp: number;
        feelsLike: number;
        weatherCode: number;
        city: string;
        hourly: Array<{ time: string; temp: number; weatherCode: number }>;
      };
      const weatherResult = { temp: data.temp, feelsLike: data.feelsLike, weatherCode: data.weatherCode, hourly: data.hourly };
      setWeatherData(weatherResult);
      setWeatherCache(city, weatherResult);
    } catch {
      if (signal?.aborted) return;
      setWeatherError("Could not load weather");
    } finally {
      if (!signal?.aborted) setWeatherLoading(false);
    }
  }, []);

  const fetchClothingSuggestion = useCallback(async (activity?: string, signal?: AbortSignal) => {
    if (!geminiApiKey || !weatherData) return;

    // Check cache — skip API call if we already have a suggestion for this combo
    const cacheKey = `${weatherLocation}-${weatherData.temp}-${weatherData.weatherCode}-${activity ?? ""}`;
    const cached = clothingCacheRef.current.get(cacheKey);
    if (cached) {
      setClothingSuggestion(cached);
      return;
    }

    setClothingLoading(true);
    try {
      const condition = WEATHER_CODE_MAP[weatherData.weatherCode]?.label ?? "Unknown";
      const hourlyForecast = weatherData.hourly.map(h => ({
        time: h.time,
        temp: h.temp,
        condition: WEATHER_CODE_MAP[h.weatherCode]?.label ?? "Unknown",
      }));
      const res = await fetch("/api/weather", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          temp: weatherData.temp,
          feelsLike: weatherData.feelsLike,
          condition,
          hourlyForecast,
          activity: activity ?? "",
          apiKey: geminiApiKey,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { suggestion: string };
        if (!signal?.aborted) {
          setClothingSuggestion(data.suggestion);
          clothingCacheRef.current.set(cacheKey, data.suggestion);
        }
      } else if (!signal?.aborted) {
        const errData = (await res.json().catch(() => null)) as { error?: string } | null;
        // Show error inline — rule-based fallback still renders below
        setClothingSuggestion(errData?.error ?? "AI suggestion unavailable. Try again later.");
      }
    } catch {
      // Fall back silently — rule-based suggestion will show
    } finally {
      if (!signal?.aborted) setClothingLoading(false);
    }
  }, [geminiApiKey, weatherData, weatherLocation]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchWeather(weatherLocation, controller.signal);
    return () => controller.abort();
  }, [weatherLocation, fetchWeather]);

  // Clear clothing cache when weather/location changes materially
  useEffect(() => {
    if (!weatherData) return;
    const hash = `${weatherLocation}-${weatherData.temp}-${weatherData.weatherCode}`;
    if (hash !== lastWeatherHashRef.current) {
      lastWeatherHashRef.current = hash;
      clothingCacheRef.current.clear();
      setClothingSuggestion("");
    }
  }, [weatherData, weatherLocation]);

  // Fetch the AI what-to-wear line for the masthead once weather + a Gemini key are available
  useEffect(() => {
    if (!weatherData || !geminiApiKey) return;
    const controller = new AbortController();
    void fetchClothingSuggestion(undefined, controller.signal);
    return () => controller.abort();
  }, [weatherData, geminiApiKey, fetchClothingSuggestion]);

  // Calendar feed functions
  const fetchCalendarEvents = useCallback(async (urls: string[], signal?: AbortSignal) => {
    if (!urls.length) return;
    setCalendarLoading(true);
    try {
      const res = await fetch("/api/calendar/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        signal,
      });
      if (signal?.aborted) return;
      if (!res.ok) return;
      const data = (await res.json()) as { groups: CalendarGroup[] };
      if (signal?.aborted) return;
      setCalendarGroups(data.groups);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
    } finally {
      if (!signal?.aborted) setCalendarLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!icalUrls.length) return;
    const controller = new AbortController();
    void fetchCalendarEvents(icalUrls, controller.signal);
    return () => controller.abort();
  }, [icalUrls, fetchCalendarEvents]);

  // Refresh calendar when tab regains focus
  useEffect(() => {
    if (!icalUrls.length) return;
    const onFocus = () => { void fetchCalendarEvents(icalUrls); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [icalUrls, fetchCalendarEvents]);

  // Fetch iCal events for an arbitrary date range (used by Task Planning)
  const fetchPlanningEvents = useCallback(async (urls: string[], rangeStart: Date, rangeEnd: Date, signal?: AbortSignal) => {
    if (!urls.length) { setPlanningEvents([]); setPlanningLoading(false); return; }
    setPlanningLoading(true);
    try {
      const res = await fetch("/api/calendar/feeds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          rangeStart: rangeStart.toISOString(),
          rangeEnd: rangeEnd.toISOString(),
        }),
        signal,
      });
      if (signal?.aborted || !res.ok) return;
      const data = (await res.json()) as { groups: CalendarGroup[] };
      if (signal?.aborted) return;
      setPlanningEvents(data.groups.flatMap(g => g.events.map(e => ({ ...e, calendar: g.name }))));
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
    } finally {
      if (!signal?.aborted) setPlanningLoading(false);
    }
  }, []);

  // Refetch planning events whenever the drawer opens or the viewed range changes
  useEffect(() => {
    if (!isCalendarDrawerOpen || !icalUrls.length) { setPlanningEvents([]); setPlanningLoading(false); return; }
    let rangeStart: Date;
    let rangeEnd: Date;
    if (calendarView === "day") {
      rangeStart = startOfDay(selectedDate);
      rangeEnd = endOfDay(selectedDate);
    } else if (calendarView === "week") {
      rangeStart = startOfWeek(selectedDate, { weekStartsOn: 0 });
      rangeEnd = endOfWeek(selectedDate, { weekStartsOn: 0 });
    } else {
      // Month grid includes padding days from adjacent months
      rangeStart = startOfWeek(startOfMonth(selectedDate), { weekStartsOn: 0 });
      rangeEnd = endOfWeek(endOfMonth(selectedDate), { weekStartsOn: 0 });
    }
    const controller = new AbortController();
    void fetchPlanningEvents(icalUrls, rangeStart, rangeEnd, controller.signal);
    return () => controller.abort();
  }, [isCalendarDrawerOpen, calendarView, selectedDate, icalUrls, fetchPlanningEvents]);

  // Checklist functions
  const fetchChecklistItems = async () => {
    try {
      const response = await fetch("/api/checklist");
      if (response.ok) {
        const data = await response.json() as ChecklistItem[];
        setChecklistItems(data);
      }
    } catch {
      // Silently fail
    }
  };

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const todayDayOfWeek = new Date().getDay();

  const isChecklistItemVisibleToday = (item: ChecklistItem) => {
    if (item.frequency === "daily") return true;
    return item.daysOfWeek?.includes(todayDayOfWeek) ?? false;
  };

  const isChecklistItemCompletedToday = (item: ChecklistItem) => {
    return item.completedDates.includes(todayStr);
  };

  const todaysChecklistItems = checklistItems.filter(isChecklistItemVisibleToday);
  const completedCount = todaysChecklistItems.filter(isChecklistItemCompletedToday).length;

  // Maintenance items that are due today / overdue (or were completed today, so
  // they show as done before rescheduling out of view). Surfaced in the routine card.
  const isMaintenanceDoneToday = (m: MaintenanceItem) => m.lastCompletedDate === todayStr;
  const maintenanceDaysLate = (m: MaintenanceItem) =>
    Math.round((new Date(todayStr).getTime() - new Date(m.nextDueDate).getTime()) / 86400000);
  const dueMaintenanceItems = maintenanceItems
    .filter(m => m.nextDueDate <= todayStr || isMaintenanceDoneToday(m))
    .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
  const routineTotal = todaysChecklistItems.length + dueMaintenanceItems.length;
  const routineDone = completedCount + dueMaintenanceItems.filter(isMaintenanceDoneToday).length;

  // Today's app tasks (with a due date) shown alongside calendar events in the side panel
  const todaysScheduledTasks = tasks
    .filter(t => t.dueDate && isSameDay(new Date(t.dueDate), new Date()))
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());

  // Combined Today's schedule: in-app timed tasks + today's iCal calendar events
  // (calendarGroups is fetched on mount with today's bounds, across all feeds).
  const todaysCalendarEvents = calendarGroups.flatMap(g =>
    g.events.map(e => ({ ...e, calendar: g.name }))
  );
  const calendarFeedError = calendarGroups.some(g => g.error);
  type ScheduleItem =
    | { kind: "task"; id: string; time: number; task: Task }
    | { kind: "event"; id: string; time: number; event: PlanningEvent };
  const todaysScheduleItems: ScheduleItem[] = [
    ...todaysScheduledTasks.map(t => ({
      kind: "task" as const, id: t._id,
      time: t.dueDate ? new Date(t.dueDate).getTime() : 0, task: t,
    })),
    ...todaysCalendarEvents.map(e => ({
      kind: "event" as const, id: e.id,
      time: new Date(e.start).getTime(), event: e,
    })),
  ].sort((a, b) => a.time - b.time);

  const handleToggleChecklistItem = async (id: string) => {
    // Optimistic update
    setChecklistItems(prev =>
      prev.map(item => {
        if (item._id !== id) return item;
        const isCompleted = item.completedDates.includes(todayStr);
        return {
          ...item,
          completedDates: isCompleted
            ? item.completedDates.filter(d => d !== todayStr)
            : [...item.completedDates, todayStr],
        };
      })
    );

    const item = checklistItems.find(i => i._id === id);
    if (item) {
      const wasCompleted = item.completedDates.includes(todayStr);
      if (wasCompleted) {
        playUncompleteSound();
      } else {
        playCompletionSound();
      }
    }

    try {
      await fetch("/api/checklist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: id, date: todayStr }),
      });
    } catch {
      // Revert on failure
      void fetchChecklistItems();
    }
  };

  const resetChecklistForm = () => {
    setChecklistFormData({ title: "", description: "", frequency: "daily", daysOfWeek: [] });
    setEditingChecklistItem(null);
    setShowChecklistForm(false);
  };

  // Move a routine item within the list currently on screen. Items hidden by the
  // active tab keep their absolute slots, so reordering a filtered view behaves
  // the way it looks.
  const handleReorderChecklistItem = async (item: ChecklistItem, dir: "up" | "down", visible: ChecklistItem[]) => {
    const idx = visible.findIndex(i => i._id === item._id);
    const swapWith = dir === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || swapWith < 0 || swapWith >= visible.length) return;
    const reordered = [...visible];
    [reordered[idx], reordered[swapWith]] = [reordered[swapWith]!, reordered[idx]!];

    const visibleIds = new Set(visible.map(i => i._id));
    let k = 0;
    const full = checklistItems.map(i => visibleIds.has(i._id) ? reordered[k++]! : i);
    const items = full.map((i, sortOrder) => ({ _id: i._id, sortOrder }));

    setChecklistItems(full.map((i, sortOrder) => ({ ...i, sortOrder })));
    try {
      const res = await fetch("/api/checklist/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) void fetchChecklistItems();
    } catch {
      void fetchChecklistItems();
    }
  };

  const handleAddChecklistItem = async () => {
    if (!checklistFormData.title.trim()) return;
    setChecklistLoading(true);
    try {
      const response = await fetch("/api/checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: checklistFormData.title.trim(),
          description: checklistFormData.description.trim() || undefined,
          frequency: checklistFormData.frequency,
          daysOfWeek: checklistFormData.frequency === "weekly" ? checklistFormData.daysOfWeek : undefined,
        }),
      });
      if (response.ok) {
        const newItem = await response.json() as ChecklistItem;
        setChecklistItems(prev => [...prev, newItem]);
        resetChecklistForm();
        toast.success("Routine item added");
      }
    } catch {
      toast.error("Failed to add routine item");
    } finally {
      setChecklistLoading(false);
    }
  };

  const handleUpdateChecklistItem = async () => {
    if (!editingChecklistItem || !checklistFormData.title.trim()) return;
    setChecklistLoading(true);
    try {
      const response = await fetch("/api/checklist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: editingChecklistItem._id,
          title: checklistFormData.title.trim(),
          description: checklistFormData.description.trim() || null,
          frequency: checklistFormData.frequency,
          daysOfWeek: checklistFormData.frequency === "weekly" ? checklistFormData.daysOfWeek : null,
        }),
      });
      if (response.ok) {
        const updated = await response.json() as ChecklistItem;
        setChecklistItems(prev => prev.map(i => i._id === updated._id ? updated : i));
        resetChecklistForm();
        toast.success("Routine item updated");
      }
    } catch {
      toast.error("Failed to update routine item");
    } finally {
      setChecklistLoading(false);
    }
  };

  const handleDeleteChecklistItem = async (id: string) => {
    setChecklistItems(prev => prev.filter(i => i._id !== id));
    try {
      const response = await fetch(`/api/checklist?id=${id}`, { method: "DELETE" });
      if (!response.ok) {
        void fetchChecklistItems();
        toast.error("Failed to delete routine item");
      }
    } catch {
      void fetchChecklistItems();
      toast.error("Failed to delete routine item");
    }
  };

  const openChecklistItemForEdit = (item: ChecklistItem) => {
    setEditingChecklistItem(item);
    setChecklistFormData({
      title: item.title,
      description: item.description ?? "",
      frequency: item.frequency,
      daysOfWeek: item.daysOfWeek ?? [],
    });
    setShowChecklistForm(true);
  };

  // Maintenance item functions
  const fetchMaintenanceItems = async () => {
    try {
      const res = await fetch("/api/maintenance");
      if (res.ok) setMaintenanceItems(await res.json() as MaintenanceItem[]);
    } catch { /* silently fail */ }
  };

  const handleAddMaintenanceItem = async () => {
    if (!maintenanceFormData.title.trim()) return;
    const nextDue = maintenanceFormData.nextDueDate || (() => {
      const d = new Date();
      d.setDate(d.getDate() + maintenanceFormData.intervalDays);
      return d.toISOString().slice(0, 10);
    })();
    try {
      const res = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: maintenanceFormData.title.trim(), description: maintenanceFormData.description.trim() || undefined, intervalDays: maintenanceFormData.intervalDays, nextDueDate: nextDue }),
      });
      if (res.ok) {
        await fetchMaintenanceItems();
        setMaintenanceFormData({ title: "", description: "", intervalDays: 90, nextDueDate: "" });
        setShowMaintenanceForm(false);
      }
    } catch { /* silently fail */ }
  };

  const handleUpdateMaintenanceItem = async () => {
    if (!editingMaintenanceItem || !maintenanceFormData.title.trim()) return;
    try {
      const res = await fetch("/api/maintenance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: editingMaintenanceItem._id,
          title: maintenanceFormData.title.trim(),
          description: maintenanceFormData.description.trim() || null,
          intervalDays: maintenanceFormData.intervalDays,
          ...(maintenanceFormData.nextDueDate ? { nextDueDate: maintenanceFormData.nextDueDate } : {}),
        }),
      });
      if (res.ok) {
        await fetchMaintenanceItems();
        setMaintenanceFormData({ title: "", description: "", intervalDays: 90, nextDueDate: "" });
        setEditingMaintenanceItem(null);
        setShowMaintenanceForm(false);
      }
    } catch { /* silently fail */ }
  };

  const handleDeleteMaintenanceItem = async (id: string) => {
    setMaintenanceItems(prev => prev.filter(i => i._id !== id));
    try {
      const res = await fetch(`/api/maintenance?id=${id}`, { method: "DELETE" });
      if (!res.ok) void fetchMaintenanceItems();
    } catch { void fetchMaintenanceItems(); }
  };

  const handleMarkMaintenanceDone = async (id: string) => {
    try {
      const res = await fetch("/api/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: id }),
      });
      if (res.ok) await fetchMaintenanceItems();
    } catch { /* silently fail */ }
  };

  const resetMaintenanceForm = () => {
    setMaintenanceFormData({ title: "", description: "", intervalDays: 90, nextDueDate: "" });
    setEditingMaintenanceItem(null);
    setShowMaintenanceForm(false);
  };

  // Goals functions
  const weekKeyOf = (d: Date) => format(startOfWeek(d, { weekStartsOn: 0 }), "yyyy-MM-dd");
  const monthKeyOf = (d: Date) => format(d, "yyyy-MM");
  const yearKeyOf = (d: Date) => format(d, "yyyy");
  const keyOfPeriod = (pt: GoalPeriodType, d: Date) =>
    pt === "week" ? weekKeyOf(d) : pt === "month" ? monthKeyOf(d) : yearKeyOf(d);
  const currentWeekKey = weekKeyOf(new Date());
  const currentMonthKey = monthKeyOf(new Date());
  const currentYearKey = yearKeyOf(new Date());
  // Custom goals aren't navigable by a single period; the panel lists them all.
  const isCustomPeriod = goalsPanelPeriodType === "custom";
  const goalsPanelKey = isCustomPeriod ? "" : keyOfPeriod(goalsPanelPeriodType, goalsPanelDate);
  const goalsPanelCurrentKey = isCustomPeriod ? "" : keyOfPeriod(goalsPanelPeriodType, new Date());
  const isViewingPastPeriod = !isCustomPeriod && goalsPanelKey < goalsPanelCurrentKey;

  // Goals whose period has already ended and that were never achieved. These are
  // easy to lose track of, since finding them otherwise means paging back
  // through each period one at a time.
  const pastUnfinishedGoals = goals
    .filter(g => g.status === "active")
    .filter(g => g.periodType === "custom"
      ? !!g.endDate && g.endDate < todayStr
      : g.periodKey < keyOfPeriod(g.periodType, new Date()))
    .sort((a, b) => (b.endDate ?? b.periodKey).localeCompare(a.endDate ?? a.periodKey));

  const currentWeekGoals = goals.filter(g => g.periodType === "week" && g.periodKey === currentWeekKey);
  const currentMonthGoals = goals.filter(g => g.periodType === "month" && g.periodKey === currentMonthKey);
  const currentYearGoals = goals.filter(g => g.periodType === "year" && g.periodKey === currentYearKey);
  const goalsPanelGoals = isCustomPeriod
    ? goals
        .filter(g => g.periodType === "custom")
        .sort((a, b) => (a.endDate ?? "").localeCompare(b.endDate ?? ""))
    : goals.filter(g => g.periodType === goalsPanelPeriodType && g.periodKey === goalsPanelKey);

  const goalsById = useMemo(() => new Map(goals.map(g => [g._id, g])), [goals]);

  const goalTaskCounts = useMemo(() => {
    const counts = new Map<string, { done: number; total: number }>();
    for (const task of tasks) {
      if (!task.goalId) continue;
      const entry = counts.get(task.goalId) ?? { done: 0, total: 0 };
      // A task with subtasks contributes its subtasks (the real unit of work);
      // a standalone task contributes itself. Keeps goal progress meaningful
      // when a goal is driven by one task's checklist.
      const subtaskCount = task.subtaskCount ?? 0;
      if (subtaskCount > 0) {
        entry.total += subtaskCount;
        entry.done += task.subtaskCompletedCount ?? 0;
      } else {
        entry.total += 1;
        if (task.status === "completed") entry.done += 1;
      }
      counts.set(task.goalId, entry);
    }
    return counts;
  }, [tasks]);

  // Goals selectable as the parent for the goal being added/edited in the panel.
  // Weekly goals link up to the month they fall in; monthly goals to their year.
  const parentGoalOptions = (() => {
    let candidates: Goal[] = [];
    if (goalsPanelPeriodType === "week") {
      const monthKey = goalsPanelKey.slice(0, 7);
      candidates = goals.filter(g => g.periodType === "month" && g.periodKey === monthKey && g.status === "active");
    } else if (goalsPanelPeriodType === "month") {
      const yearKey = goalsPanelKey.slice(0, 4);
      candidates = goals.filter(g => g.periodType === "year" && g.periodKey === yearKey && g.status === "active");
    } else {
      return [];
    }
    // Keep the currently-linked parent selectable when editing, even if achieved/dropped/other period
    if (editingGoal?.parentGoalId && !candidates.some(g => g._id === editingGoal.parentGoalId)) {
      const linked = goalsById.get(editingGoal.parentGoalId);
      if (linked) return [linked, ...candidates];
    }
    return candidates;
  })();
  const canLinkParent = goalsPanelPeriodType === "week" || goalsPanelPeriodType === "month";
  const parentLinkPlaceholder = goalsPanelPeriodType === "week"
    ? "Link to a monthly goal (optional)"
    : "Link to a yearly goal (optional)";

  const fetchGoals = async () => {
    try {
      const response = await fetch("/api/goals");
      if (response.ok) {
        const data = await response.json() as Goal[];
        setGoals(data);
      }
    } catch {
      // Silently fail
    }
  };

  const resetGoalForm = () => {
    setGoalFormData({ title: "", icon: "", note: "", parentGoalId: "", startDate: "", endDate: "" });
    setEditingGoal(null);
    setShowGoalForm(false);
  };

  // A custom goal's date range is valid when both dates are set and ordered
  const customRangeValid = !isCustomPeriod ||
    (!!goalFormData.startDate && !!goalFormData.endDate && goalFormData.endDate >= goalFormData.startDate);

  // Set a custom range starting today, ending `days` out (30/60/90 presets)
  const applyCustomPreset = (days: number) => {
    const today = new Date();
    setGoalFormData(p => ({
      ...p,
      startDate: format(today, "yyyy-MM-dd"),
      endDate: format(addDays(today, days), "yyyy-MM-dd"),
    }));
  };

  const handleAddGoal = async () => {
    if (!goalFormData.title.trim() || !customRangeValid) return;
    setGoalsLoading(true);
    try {
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: goalFormData.title.trim(),
          icon: goalFormData.icon || undefined,
          note: goalFormData.note.trim() || undefined,
          periodType: goalsPanelPeriodType,
          periodKey: isCustomPeriod ? goalFormData.startDate : goalsPanelKey,
          startDate: isCustomPeriod ? goalFormData.startDate : undefined,
          endDate: isCustomPeriod ? goalFormData.endDate : undefined,
          parentGoalId: canLinkParent ? (goalFormData.parentGoalId || undefined) : undefined,
        }),
      });
      if (response.ok) {
        const newGoal = await response.json() as Goal;
        setGoals(prev => [...prev, newGoal]);
        resetGoalForm();
        toast.success("Goal added");
      } else {
        toast.error("Failed to add goal");
      }
    } catch {
      toast.error("Failed to add goal");
    } finally {
      setGoalsLoading(false);
    }
  };

  const handleUpdateGoal = async () => {
    if (!editingGoal || !goalFormData.title.trim() || !customRangeValid) return;
    setGoalsLoading(true);
    try {
      const response = await fetch("/api/goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: editingGoal._id,
          title: goalFormData.title.trim(),
          icon: goalFormData.icon || null,
          note: goalFormData.note.trim() || null,
          ...(editingGoal.periodType === "week" || editingGoal.periodType === "month"
            ? { parentGoalId: goalFormData.parentGoalId || null }
            : {}),
          ...(editingGoal.periodType === "custom"
            ? { startDate: goalFormData.startDate, endDate: goalFormData.endDate }
            : {}),
        }),
      });
      if (response.ok) {
        const updated = await response.json() as Goal;
        setGoals(prev => prev.map(g => g._id === updated._id ? updated : g));
        resetGoalForm();
        toast.success("Goal updated");
      } else {
        toast.error("Failed to update goal");
      }
    } catch {
      toast.error("Failed to update goal");
    } finally {
      setGoalsLoading(false);
    }
  };

  const handleSetGoalStatus = async (goal: Goal, status: GoalStatus) => {
    // Optimistic update
    setGoals(prev => prev.map(g => g._id === goal._id ? { ...g, status } : g));
    if (status === "achieved") {
      playCompletionSound();
    } else if (goal.status === "achieved") {
      playUncompleteSound();
    }
    try {
      const response = await fetch("/api/goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: goal._id, status }),
      });
      if (!response.ok) void fetchGoals();
    } catch {
      void fetchGoals();
    }
  };

  const handleToggleGoalAchieved = (goal: Goal) => {
    void handleSetGoalStatus(goal, goal.status === "achieved" ? "active" : "achieved");
  };

  const handleToggleGoalPinned = async (goal: Goal) => {
    const pinned = !goal.pinned;
    // Optimistic update
    setGoals(prev => prev.map(g => g._id === goal._id ? { ...g, pinned } : g));
    try {
      const response = await fetch("/api/goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: goal._id, pinned }),
      });
      if (!response.ok) void fetchGoals();
    } catch {
      void fetchGoals();
    }
  };

  // Move a goal to a different period. Week/Month/Year target the current
  // period; Custom starts a 90-day window from today (editable afterward).
  const handleMoveGoal = async (goal: Goal, target: GoalPeriodType) => {
    if (goal.periodType === target && target !== "custom") return;
    const today = new Date();
    const targetKey = target === "week" ? currentWeekKey
      : target === "month" ? currentMonthKey
      : target === "year" ? currentYearKey
      : format(today, "yyyy-MM-dd");
    const startDate = target === "custom" ? format(today, "yyyy-MM-dd") : undefined;
    const endDate = target === "custom" ? format(addDays(today, 90), "yyyy-MM-dd") : undefined;
    const label = target === "week" ? "this week" : target === "month" ? "this month" : target === "year" ? "this year" : "Custom";
    // Optimistic: re-file the goal and detach any children that linked to it.
    setGoals(prev => prev.map(g => {
      if (g._id === goal._id) return { ...g, periodType: target, periodKey: targetKey, startDate, endDate, parentGoalId: undefined };
      if (g.parentGoalId === goal._id) return { ...g, parentGoalId: undefined };
      return g;
    }));
    try {
      const response = await fetch("/api/goals", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: goal._id, periodType: target, periodKey: targetKey, ...(target === "custom" ? { startDate, endDate } : {}) }),
      });
      if (response.ok) {
        const updated = await response.json() as Goal;
        setGoals(prev => prev.map(g => g._id === updated._id ? updated : g));
        toast.success(`Moved to ${label}`);
      } else {
        void fetchGoals();
        toast.error("Failed to move goal");
      }
    } catch {
      void fetchGoals();
      toast.error("Failed to move goal");
    }
  };

  const handleDeleteGoal = async (id: string) => {
    // Optimistic: mirror the server-side cascade locally
    setGoals(prev => prev
      .filter(g => g._id !== id)
      .map(g => g.parentGoalId === id ? { ...g, parentGoalId: undefined } : g)
    );
    setTasks(prev => prev.map(t => t.goalId === id ? { ...t, goalId: undefined } : t));
    if (editingGoal?._id === id) resetGoalForm();
    try {
      const response = await fetch(`/api/goals?id=${id}`, { method: "DELETE" });
      if (!response.ok) {
        void fetchGoals();
        void fetchTasks();
        toast.error("Failed to delete goal");
      }
    } catch {
      void fetchGoals();
      void fetchTasks();
      toast.error("Failed to delete goal");
    }
  };

  const handleCopyGoalToCurrentPeriod = async (goal: Goal) => {
    // A custom goal has no "current period" to land in, so it gets a fresh
    // window of the same length starting today.
    let customRange: { startDate: string; endDate: string } | undefined;
    if (goal.periodType === "custom") {
      const days = goal.startDate && goal.endDate
        ? Math.max(1, Math.round((new Date(goal.endDate).getTime() - new Date(goal.startDate).getTime()) / 86400000))
        : 90;
      const today = new Date();
      customRange = {
        startDate: format(today, "yyyy-MM-dd"),
        endDate: format(addDays(today, days), "yyyy-MM-dd"),
      };
    }
    const targetKey = goal.periodType === "week" ? currentWeekKey
      : goal.periodType === "month" ? currentMonthKey
      : goal.periodType === "custom" ? (customRange?.startDate ?? "")
      : currentYearKey;
    // Keep the parent link only if the parent belongs to the current parent period
    const parent = goal.parentGoalId ? goalsById.get(goal.parentGoalId) : undefined;
    const parentCurrentKey = goal.periodType === "week" ? currentMonthKey : currentYearKey;
    const keepParent = parent && parent.periodKey === parentCurrentKey;
    try {
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: goal.title,
          icon: goal.icon,
          note: goal.note,
          periodType: goal.periodType,
          periodKey: targetKey,
          ...(customRange ?? {}),
          parentGoalId: keepParent ? goal.parentGoalId : undefined,
        }),
      });
      if (response.ok) {
        const newGoal = await response.json() as Goal;
        setGoals(prev => [...prev, newGoal]);
        const label = goal.periodType === "week" ? "this week"
          : goal.periodType === "month" ? "this month"
          : goal.periodType === "custom" ? "a new window"
          : "this year";
        toast.success(`Brought forward to ${label}`);
      } else {
        toast.error("Failed to copy goal");
      }
    } catch {
      toast.error("Failed to copy goal");
    }
  };

  const openGoalForEdit = (goal: Goal) => {
    setEditingGoal(goal);
    setGoalFormData({
      title: goal.title,
      icon: goal.icon ?? "",
      note: goal.note ?? "",
      parentGoalId: goal.parentGoalId ?? "",
      startDate: goal.startDate ?? "",
      endDate: goal.endDate ?? "",
    });
    setShowGoalForm(true);
  };

  const navigateGoalsPeriod = (direction: "prev" | "next") => {
    resetGoalForm();
    setGoalsPanelDate(d => {
      if (goalsPanelPeriodType === "week") {
        return direction === "prev" ? subWeeks(d, 1) : addWeeks(d, 1);
      }
      if (goalsPanelPeriodType === "month") {
        return direction === "prev" ? subMonths(d, 1) : addMonths(d, 1);
      }
      return direction === "prev" ? subYears(d, 1) : addYears(d, 1);
    });
  };

  // Compact goal row used in the "This Week / This Month" strip
  // Label for a goal option in the task-form selects, with period context for stale goals
  const goalOptionLabel = (goal: Goal) => {
    if (goal.periodType === "week" && goal.periodKey === currentWeekKey) return goal.title;
    if (goal.periodType === "month" && goal.periodKey === currentMonthKey) return goal.title;
    if (goal.periodType === "year" && goal.periodKey === currentYearKey) return goal.title;
    if (goal.periodType === "week") {
      const [y = 0, m = 1, d = 1] = goal.periodKey.split("-").map(Number);
      return `${goal.title} (week of ${format(new Date(y, m - 1, d), "MMM d")})`;
    }
    if (goal.periodType === "month") {
      const [y = 0, m = 1] = goal.periodKey.split("-").map(Number);
      return `${goal.title} (${format(new Date(y, m - 1, 1), "MMMM yyyy")})`;
    }
    if (goal.periodType === "year") {
      return `${goal.title} (${goal.periodKey})`;
    }
    // custom
    if (goal.startDate && goal.endDate) {
      return `${goal.title} (${format(new Date(goal.startDate), "MMM d")} – ${format(new Date(goal.endDate), "MMM d")})`;
    }
    return goal.title;
  };

  // Options for the "Goal (optional)" select in both task forms. Active goals of the
  // current periods are always offered; a linked goal outside those (past period,
  // achieved/dropped) stays selectable so editing never silently drops the link.
  const renderGoalSelectOptions = (selectedGoalId: string) => {
    const today = format(new Date(), "yyyy-MM-dd");
    const weekOptions = currentWeekGoals.filter(g => g.status === "active");
    const monthOptions = currentMonthGoals.filter(g => g.status === "active");
    const yearOptions = currentYearGoals.filter(g => g.status === "active");
    // Custom goals whose range is currently active
    const customOptions = goals.filter(g =>
      g.periodType === "custom" && g.status === "active" &&
      (g.startDate ?? "") <= today && (g.endDate ?? "") >= today);
    const selected = selectedGoalId ? goalsById.get(selectedGoalId) : undefined;
    const selectedIsListed = !!selected &&
      [weekOptions, monthOptions, yearOptions, customOptions].some(list => list.some(g => g._id === selected._id));
    return (
      <>
        <option value="">No goal</option>
        {selected && !selectedIsListed && (
          <option value={selected._id}>{goalOptionLabel(selected)}</option>
        )}
        {weekOptions.length > 0 && (
          <optgroup label="This Week">
            {weekOptions.map(g => (
              <option key={g._id} value={g._id}>{g.title}</option>
            ))}
          </optgroup>
        )}
        {monthOptions.length > 0 && (
          <optgroup label="This Month">
            {monthOptions.map(g => (
              <option key={g._id} value={g._id}>{g.title}</option>
            ))}
          </optgroup>
        )}
        {yearOptions.length > 0 && (
          <optgroup label="This Year">
            {yearOptions.map(g => (
              <option key={g._id} value={g._id}>{g.title}</option>
            ))}
          </optgroup>
        )}
        {customOptions.length > 0 && (
          <optgroup label="Custom">
            {customOptions.map(g => (
              <option key={g._id} value={g._id}>{goalOptionLabel(g)}</option>
            ))}
          </optgroup>
        )}
      </>
    );
  };

  // Payments due (external finance API, grouped by account). The date is a
  // local calendar string end to end — it is never turned into a Date and back,
  // so no timezone conversion can shift the day the user asked for.
  const fetchPaymentsDue = async (date: string) => {
    setPaymentsError(false);
    try {
      const res = await fetch(`/api/payments?date=${date}`);
      if (res.ok) {
        setPaymentsData(await res.json() as PaymentsDueData);
      } else {
        setPaymentsError(true);
      }
    } catch {
      setPaymentsError(true);
    }
  };

  // Paid state is per-day and local-only until the finance API supports
  // write-back. It keys off the day being viewed, so ticking something off
  // while browsing another date can't land on today's list.
  const paidPaymentsStorageKey = () => `eisenq-payments-paid-${paymentsDate}`;

  const togglePaymentAccountPaid = (accountId: string) => {
    const wasPaid = paidPaymentAccounts.has(accountId);
    if (wasPaid) {
      playUncompleteSound();
    } else {
      playCompletionSound();
    }
    const next = new Set(paidPaymentAccounts);
    if (wasPaid) {
      next.delete(accountId);
    } else {
      next.add(accountId);
    }
    setPaidPaymentAccounts(next);
    try {
      localStorage.setItem(paidPaymentsStorageKey(), JSON.stringify([...next]));
    } catch { /* ignore */ }
  };

  const togglePaymentAccountExpanded = (accountId: string) => {
    setExpandedPaymentAccounts(prev => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const handleAddTask = async () => {
    try {
      setTaskOperationLoading(prev => ({ ...prev, addTask: true }));
      setQuadrantLoading(prev => ({ ...prev, [formData.quadrant]: true }));

      // Convert date and time to ISO datetime if provided
      let dueDateValue: string | undefined = undefined;
      if (formData.dueDate) {
        const dateParts = formData.dueDate.split('-').map(Number);
        const timeParts = formData.dueTime.split(':').map(Number);
        const year = dateParts[0] ?? 2025;
        const month = dateParts[1] ?? 1;
        const day = dateParts[2] ?? 1;
        const hours = timeParts[0] ?? 12;
        const minutes = timeParts[1] ?? 0;

        const newDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
        dueDateValue = newDate.toISOString();
      }

      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: formData.title,
          description: formData.description,
          quadrant: formData.quadrant,
          priority: formData.quadrant === "urgent-important" ? "high" : formData.priority,
          dueDate: dueDateValue,
          duration: formData.duration || undefined,
          goalId: formData.goalId || undefined
        })
      });

      if (response.ok) {
        const newTask = await response.json() as Task;
        setTasks(prev => [...prev, newTask]);
        closeModal();
        toast.success("Task added successfully!");
      } else {
        toast.error("Failed to add task");
      }
    } catch {
      toast.error("Error adding task");
    } finally {
      setTaskOperationLoading(prev => ({ ...prev, addTask: false }));
      setQuadrantLoading(prev => ({ ...prev, [formData.quadrant]: false }));
    }
  };

  const handleQuickAddTask = async (quadrant: TaskQuadrant, title: string) => {
    if (!title.trim()) return;
    
    try {
      setTaskOperationLoading(prev => ({ ...prev, [`quickAdd-${quadrant}`]: true }));
      setQuadrantLoading(prev => ({ ...prev, [quadrant]: true }));
      
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          quadrant,
          priority: quadrant === "urgent-important" ? "high" : "medium",
          status: "pending"
        })
      });
      
      if (response.ok) {
        const newTask = await response.json() as Task;
        setTasks(prev => [...prev, newTask]);
        setQuickTaskInputs(prev => ({ ...prev, [quadrant]: "" }));
        toast.success("Task added!");
      } else {
        toast.error("Failed to add task");
      }
    } catch {
      toast.error("Error adding task");
    } finally {
      setTaskOperationLoading(prev => ({ ...prev, [`quickAdd-${quadrant}`]: false }));
      setQuadrantLoading(prev => ({ ...prev, [quadrant]: false }));
    }
  };

  const handleUpdateTask = async () => {
    if (!editingTask) return;

    // Save returns the full task document and the client replaces state with it,
    // so any tick still in the debounce window would be silently discarded.
    await flushAllStepOps();

    try {
      setTaskOperationLoading(prev => ({ ...prev, updateTask: true }));
      // Set loading for both old and new quadrants if they differ
      setQuadrantLoading(prev => ({ 
        ...prev, 
        [editingTask.quadrant]: true,
        [formData.quadrant]: true 
      }));
      
      // Convert date and time to ISO datetime if provided, or null to clear
      let dueDateValue: string | null = null;
      if (formData.dueDate) {
        // Parse the date string parts to avoid timezone issues
        const dateParts = formData.dueDate.split('-').map(Number);
        const timeParts = formData.dueTime.split(':').map(Number);
        const year = dateParts[0] ?? 2025;
        const month = dateParts[1] ?? 1;
        const day = dateParts[2] ?? 1;
        const hours = timeParts[0] ?? 12;
        const minutes = timeParts[1] ?? 0;

        // Create date in local timezone with the specified time
        const newDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
        dueDateValue = newDate.toISOString();
      }

      const response = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: editingTask._id,
          title: formData.title,
          description: formData.description,
          quadrant: formData.quadrant,
          priority: formData.quadrant === "urgent-important" ? "high" : formData.priority,
          dueDate: dueDateValue,
          duration: formData.duration || null,
          goalId: formData.goalId || null,
          linkedParentId: formData.linkedParentId || null
        })
      });

      if (response.ok) {
        const updatedTask = await response.json() as Task;
        const linkChanged = (editingTask.linkedParentId ?? "") !== (formData.linkedParentId || "");
        // Preserve subtask counts - use current subtasks array as source of truth
        // since editingTask might have stale values due to closure
        setTasks(prev => {
          const existingTask = prev.find(t => t._id === updatedTask._id);
          return prev.map(task =>
            task._id === updatedTask._id
              ? {
                  ...updatedTask,
                  subtaskCount: existingTask?.subtaskCount ?? 0,
                  subtaskCompletedCount: existingTask?.subtaskCompletedCount ?? 0
                }
              : task
          );
        });
        // A changed soft-link shifts another task's subtask counts; reconcile from server.
        if (linkChanged) void fetchTasks();
        closeModal();
        toast.success("Task updated successfully!");
      } else {
        toast.error("Failed to update task");
      }
    } catch {
      toast.error("Error updating task");
    } finally {
      setTaskOperationLoading(prev => ({ ...prev, updateTask: false }));
      setQuadrantLoading(prev => ({ 
        ...prev, 
        [editingTask.quadrant]: false,
        [formData.quadrant]: false 
      }));
    }
  };

  // Export the task being edited to a calendar provider / .ics, using its due
  // date + time and duration (defaults to 30 min).
  const exportEditingTaskToCalendar = (provider: Parameters<typeof addToCalendar>[1]) => {
    if (!formData.dueDate) return;
    const [y, m, d] = formData.dueDate.split("-").map(Number);
    const [hh, mm] = (formData.dueTime || "09:00").split(":").map(Number);
    const startDate = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 9, mm ?? 0);
    const durationMin = (typeof formData.duration === "number" ? formData.duration : 0) || 30;
    const endDate = new Date(startDate.getTime() + durationMin * 60 * 1000);
    addToCalendar({ title: formData.title, description: formData.description, startDate, endDate }, provider);
  };

  // Archive a task: it leaves the matrix but is kept until deleted from settings.
  const handleArchiveTask = async (task: Task, opts?: { silent?: boolean }) => {
    setTasks(prev => prev.filter(t => t._id !== task._id));
    try {
      const res = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: task._id, archived: true }),
      });
      if (!res.ok) {
        void fetchTasks();
        toast.error("Failed to archive task");
      } else if (!opts?.silent) {
        toast.success("Task archived");
      }
    } catch {
      void fetchTasks();
      toast.error("Failed to archive task");
    }
  };

  const fetchArchivedTasks = async () => {
    try {
      const res = await fetch("/api/tasks/archived");
      if (res.ok) setArchivedTasks(await res.json() as Task[]);
    } catch { /* non-critical */ }
  };

  // Put an archived task back into its quadrant.
  const handleRestoreTask = async (task: Task) => {
    setArchivedTasks(prev => prev.filter(t => t._id !== task._id));
    try {
      const res = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: task._id, archived: false }),
      });
      if (res.ok) {
        void fetchTasks();
        toast.success("Task restored");
      } else {
        void fetchArchivedTasks();
        toast.error("Failed to restore task");
      }
    } catch {
      void fetchArchivedTasks();
      toast.error("Failed to restore task");
    }
  };

  const handleDeleteArchivedTasks = async () => {
    try {
      const res = await fetch("/api/tasks/archived", { method: "DELETE" });
      if (res.ok) {
        const { deleted } = await res.json() as { deleted: number };
        setArchivedTasks([]);
        toast.success(deleted === 1 ? "1 archived task deleted" : `${deleted} archived tasks deleted`);
      } else {
        toast.error("Failed to delete archived tasks");
      }
    } catch {
      toast.error("Failed to delete archived tasks");
    }
  };

  // Delete the task being edited (its subtasks cascade server-side).
  const handleDeleteTask = async (task: Task) => {
    setTasks(prev => prev.filter(t => t._id !== task._id));
    closeModal();
    try {
      const res = await fetch(`/api/tasks?id=${task._id}`, { method: "DELETE" });
      if (res.ok) {
        toast.success("Task deleted");
      } else {
        void fetchTasks();
        toast.error("Failed to delete task");
      }
    } catch {
      void fetchTasks();
      toast.error("Failed to delete task");
    }
  };

  // ===== Attached checklists =====
  // Instances live on the task, so there are exactly two stores to keep in step:
  // `tasks` and the `editingTask` snapshot the modal holds. Everything goes
  // through here. `fn` MUST be pure — it runs once per store, and an impure one
  // diverges them in a way that only shows after closing and reopening the modal.
  const applyTaskChecklists = useCallback((taskId: string, fn: (lists: TaskChecklist[]) => TaskChecklist[]) => {
    setTasks(prev => prev.map(t => (t._id === taskId ? { ...t, checklists: fn(t.checklists ?? []) } : t)));
    setEditingTask(prev => (prev && prev._id === taskId ? { ...prev, checklists: fn(prev.checklists ?? []) } : prev));
  }, []);

  const mapChecklist = (checklistId: string, f: (c: TaskChecklist) => TaskChecklist) =>
    (lists: TaskChecklist[]) => lists.map(c => (c.id === checklistId ? f(c) : c));

  /** Required steps outstanding on any checklist that opted into gating, or null. Optional steps never block. */
  const checklistGate = (task: Task): { remaining: number; name: string; checklistId: string } | null => {
    let remaining = 0;
    let name = "";
    let checklistId = "";
    for (const c of task.checklists ?? []) {
      if (!c.blockCompletion) continue;
      const left = requiredStepsLeft(c.steps);
      if (left > 0) {
        if (remaining === 0) { name = c.name; checklistId = c.id; }
        remaining += left;
      }
    }
    return remaining > 0 ? { remaining, name, checklistId } : null;
  };

  // Ticking is the highest-frequency write in the feature, so a run of ticks is
  // coalesced into one request rather than one per step.
  const flushStepOps = useCallback(async (key: string) => {
    const entry = pendingStepOps.current.get(key);
    if (!entry) return;
    pendingStepOps.current.delete(key);
    const timer = stepFlushTimers.current.get(key);
    if (timer) { clearTimeout(timer); stepFlushTimers.current.delete(key); }

    try {
      const res = await fetch(`/api/tasks/${entry.taskId}/checklists/${entry.checklistId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "setSteps",
          steps: [...entry.steps].map(([id, done]) => ({ id, done })),
        }),
      });
      if (!res.ok) throw new Error("save failed");
    } catch {
      // Revert to the state before this batch, not before the last tick.
      applyTaskChecklists(entry.taskId, mapChecklist(entry.checklistId, c => ({ ...c, steps: entry.snapshot })));
      toast.error("Couldn't save checklist progress");
    }
  }, [applyTaskChecklists]);

  const flushAllStepOps = useCallback(async () => {
    await Promise.all([...pendingStepOps.current.keys()].map(k => flushStepOps(k)));
  }, [flushStepOps]);

  const handleToggleChecklistStep = (taskId: string, checklist: TaskChecklist, stepId: string) => {
    const step = checklist.steps.find(s => s.id === stepId);
    if (!step) return;
    // A step added moments ago has not been given its real id yet; ticking it
    // would queue a write against an id the server has never seen.
    if (step.id.startsWith("tmp-")) return;
    const next = !step.done;
    if (next) playCompletionSound(); else playUncompleteSound();

    const nowIso = new Date().toISOString();
    applyTaskChecklists(taskId, mapChecklist(checklist.id, c => ({
      ...c,
      steps: c.steps.map(x => (x.id === stepId ? { ...x, done: next, doneAt: next ? nowIso : undefined } : x)),
    })));

    const key = `${taskId}:${checklist.id}`;
    let entry = pendingStepOps.current.get(key);
    if (!entry) {
      // Snapshot once per batch — a per-tick snapshot reverts to a mid-batch state.
      entry = { taskId, checklistId: checklist.id, steps: new Map(), snapshot: checklist.steps };
      pendingStepOps.current.set(key, entry);
    }
    entry.steps.set(stepId, next);

    const existing = stepFlushTimers.current.get(key);
    if (existing) clearTimeout(existing);
    stepFlushTimers.current.set(key, setTimeout(() => void flushStepOps(key), 600));
  };

  const handleAttachChecklist = async (taskId: string, sourceId: string) => {
    setAttachBusyId(sourceId);
    try {
      const res = await fetch(`/api/tasks/${taskId}/checklists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      const data = (await res.json()) as { checklist?: TaskChecklist; error?: string };
      if (!res.ok || !data.checklist) {
        toast.error(data.error ?? "Couldn't attach that checklist");
        return;
      }
      const attached = data.checklist;
      // Not optimistic: step ids are minted server-side by the deep copy.
      applyTaskChecklists(taskId, lists => [...lists, attached]);
      setExpandedTaskChecklistIds(prev => new Set(prev).add(attached.id));
      setAttachPickerOpen(false);
      setAttachSearch("");
      setMyndlistFetchedAt(0); // usage counts moved
    } catch {
      toast.error("Couldn't attach that checklist");
    } finally {
      setAttachBusyId(null);
    }
  };

  const handleDetachChecklist = async (taskId: string, checklistId: string) => {
    const removed = (editingTask?.checklists ?? []).find(c => c.id === checklistId);
    applyTaskChecklists(taskId, lists => lists.filter(c => c.id !== checklistId));
    try {
      const res = await fetch(`/api/tasks/${taskId}/checklists/${checklistId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("detach failed");
      setMyndlistFetchedAt(0);
    } catch {
      // Put it back where it was rather than refetching — fetchTasks() sets the
      // loading flag and flashes the whole matrix to skeletons.
      if (removed) {
        applyTaskChecklists(taskId, lists => {
          const next = [...lists];
          next.splice(Math.min(removed.order, next.length), 0, removed);
          return next;
        });
      }
      toast.error("Couldn't detach that checklist");
    }
  };

  const patchChecklist = async (taskId: string, checklistId: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/tasks/${taskId}/checklists/${checklistId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("patch failed");
    return (await res.json()) as { checklist: TaskChecklist };
  };

  const handleAddChecklistStep = async (taskId: string, checklistId: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const tempId = `tmp-${Date.now()}`;
    applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({
      ...c,
      steps: [...c.steps, { id: tempId, text: trimmed, order: c.steps.length, done: false }],
    })));
    setNewChecklistStep(prev => ({ ...prev, [checklistId]: "" }));
    try {
      const { checklist } = await patchChecklist(taskId, checklistId, { op: "addStep", text: trimmed });
      // Swap in the server's copy so the real step id lands before it can be ticked.
      applyTaskChecklists(taskId, mapChecklist(checklistId, () => checklist));
    } catch {
      applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({ ...c, steps: c.steps.filter(x => x.id !== tempId) })));
      toast.error("Couldn't add that step");
    }
  };

  const handleRemoveChecklistStep = async (taskId: string, checklistId: string, stepId: string) => {
    const before = (editingTask?.checklists ?? []).find(c => c.id === checklistId)?.steps;
    applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({ ...c, steps: c.steps.filter(x => x.id !== stepId) })));
    try {
      await patchChecklist(taskId, checklistId, { op: "removeStep", stepId });
    } catch {
      if (before) applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({ ...c, steps: before })));
      toast.error("Couldn't remove that step");
    }
  };

  const handleToggleStepOptional = async (taskId: string, checklistId: string, stepId: string) => {
    if (stepId.startsWith("tmp-")) return;
    const before = (editingTask?.checklists ?? []).find(c => c.id === checklistId)?.steps;
    const step = before?.find(s => s.id === stepId);
    if (!step) return;
    const optional = !step.optional;
    applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({
      ...c, steps: c.steps.map(x => (x.id === stepId ? { ...x, optional } : x)),
    })));
    try {
      await patchChecklist(taskId, checklistId, { op: "setOptional", stepId, optional });
    } catch {
      if (before) applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({ ...c, steps: before })));
      toast.error("Couldn't change that step");
    }
  };

  const handleResetChecklist = async (taskId: string, checklistId: string) => {
    // Drop any pending batch first, or the in-flight write re-ticks what we reset.
    const key = `${taskId}:${checklistId}`;
    const timer = stepFlushTimers.current.get(key);
    if (timer) clearTimeout(timer);
    stepFlushTimers.current.delete(key);
    pendingStepOps.current.delete(key);

    const before = (editingTask?.checklists ?? []).find(c => c.id === checklistId)?.steps;
    applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({
      ...c, steps: c.steps.map(x => ({ ...x, done: false, doneAt: undefined })),
    })));
    try {
      await patchChecklist(taskId, checklistId, { op: "reset" });
    } catch {
      if (before) applyTaskChecklists(taskId, mapChecklist(checklistId, c => ({ ...c, steps: before })));
      toast.error("Couldn't reset that checklist");
    }
  };

  const handlePushChecklistToTemplate = async (taskId: string, checklistId: string) => {
    try {
      await flushAllStepOps();
      await patchChecklist(taskId, checklistId, { op: "pushToTemplate" });
      setMyndlistFetchedAt(0);
      toast.success("Saved to your checklist library");
    } catch {
      toast.error("Couldn't save those changes to the library");
    }
  };

  const handleToggleComplete = async (task: Task) => {
    // Only completing is gated. Un-completing must never be blocked, or a gated
    // task completed by another path would be stuck completed forever.
    if (task.status !== "completed") {
      const gate = checklistGate(task);
      if (gate) {
        setGateHintTaskId(task._id);
        setTimeout(() => setGateHintTaskId(prev => (prev === task._id ? null : prev)), 4000);
        playUncompleteSound();
        return;
      }
    }
    // A tick still sitting in the debounce would be clobbered by the full task
    // document this PUT returns, so land it first.
    await flushAllStepOps();
    try {
      setTaskOperationLoading(prev => ({ ...prev, [`toggle-${task._id}`]: true }));
      setQuadrantLoading(prev => ({ ...prev, [task.quadrant]: true }));
      
      const newStatus = task.status === "completed" ? "pending" : "completed";
      
      const response = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: task._id,
          status: newStatus,
          completedAt: task.status === "completed" ? null : new Date().toISOString()
        })
      });
      
      if (response.ok) {
        const updatedTask = await response.json() as Task;
        // If this task is soft-linked under a parent, keep that parent's completed
        // count in step so goal progress and the parent's checklist stay accurate.
        const delta = task.status === "completed" ? -1 : 1;
        setTasks(prev => prev.map(t => {
          if (t._id === task._id) return updatedTask;
          if (task.linkedParentId && t._id === task.linkedParentId) {
            return { ...t, subtaskCompletedCount: Math.max(0, (t.subtaskCompletedCount ?? 0) + delta) };
          }
          return t;
        }));

        if (task.status === "completed") {
          toast.success("Task marked as pending");
          playUncompleteSound();
        } else {
          toast.success(autoArchiveCompleted ? "Task completed — archived 🎉" : "Task completed! 🎉");
          playCompletionSound();
          // With auto-archive on, a completed task leaves the board immediately
          // instead of sitting crossed off at the bottom.
          if (autoArchiveCompleted) void handleArchiveTask({ ...task, status: "completed" }, { silent: true });
        }
      } else {
        toast.error("Failed to update task");
      }
    } catch {
      toast.error("Error updating task");
    } finally {
      setTaskOperationLoading(prev => ({ ...prev, [`toggle-${task._id}`]: false }));
      setQuadrantLoading(prev => ({ ...prev, [task.quadrant]: false }));
    }
  };

  // Subtask handlers
  const handleAddSubtask = async () => {
    if (!editingTask || !newSubtaskTitle.trim()) return;

    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newSubtaskTitle.trim(),
          parentTaskId: editingTask._id,
          quadrant: editingTask.quadrant,
          priority: "medium",
        })
      });

      if (response.ok) {
        const newSubtask = await response.json() as Task;
        setSubtasks(prev => [...prev, newSubtask]);
        setNewSubtaskTitle("");

        // Update parent task's subtask count in local state
        setTasks(prev => prev.map(t =>
          t._id === editingTask._id
            ? {
                ...t,
                subtaskCount: (t.subtaskCount ?? 0) + 1,
                subtaskCompletedCount: t.subtaskCompletedCount ?? 0
              }
            : t
        ));
        // Also update editingTask
        setEditingTask(prev => prev ? {
          ...prev,
          subtaskCount: (prev.subtaskCount ?? 0) + 1,
          subtaskCompletedCount: prev.subtaskCompletedCount ?? 0
        } : null);

        toast.success("Subtask added");
      } else {
        toast.error("Failed to add subtask");
      }
    } catch {
      toast.error("Error adding subtask");
    }
  };

  const handleToggleSubtaskComplete = async (subtask: Task) => {
    const newStatus = subtask.status === "completed" ? "pending" : "completed";

    try {
      const response = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: subtask._id,
          status: newStatus,
        })
      });

      if (response.ok) {
        const updatedSubtask = await response.json() as Task;
        setSubtasks(prev => prev.map(s =>
          s._id === subtask._id ? updatedSubtask : s
        ));

        // Calculate new completed count
        const newCompletedCount = subtasks.filter(s =>
          s._id === subtask._id ? newStatus === "completed" : s.status === "completed"
        ).length;

        // Update parent's completed count, and — for a soft-linked task that also
        // lives in the matrix — its own status so both views stay in sync.
        setTasks(prev => prev.map(t => {
          if (t._id === editingTask?._id) return { ...t, subtaskCompletedCount: newCompletedCount };
          if (t._id === subtask._id) return { ...t, status: newStatus };
          return t;
        }));
        setEditingTask(prev => prev ? {
          ...prev,
          subtaskCompletedCount: newCompletedCount
        } : null);

        // Check if all subtasks are now complete - prompt to complete parent
        const allComplete = subtasks.every(s =>
          s._id === subtask._id ? newStatus === "completed" : s.status === "completed"
        );

        if (allComplete && editingTask?.status !== "completed" && subtasks.length > 0 && !(editingTask && checklistGate(editingTask))) {
          toast((t) => (
            <div className="flex items-center gap-3">
              <span>All subtasks complete! Complete parent task?</span>
              <button
                onClick={() => {
                  void handleCompleteParentTask();
                  toast.dismiss(t.id);
                }}
                className="px-3 py-1 bg-green-600 text-white rounded text-sm"
              >
                Yes
              </button>
              <button
                onClick={() => toast.dismiss(t.id)}
                className="px-3 py-1 bg-gray-600 text-white rounded text-sm"
              >
                No
              </button>
            </div>
          ), { duration: 10000 });
        }
      }
    } catch {
      toast.error("Failed to update subtask");
    }
  };

  const handleDeleteSubtask = async (subtaskId: string) => {
    try {
      const response = await fetch(`/api/tasks?id=${subtaskId}`, {
        method: "DELETE"
      });

      if (response.ok) {
        const deletedSubtask = subtasks.find(s => s._id === subtaskId);
        setSubtasks(prev => prev.filter(s => s._id !== subtaskId));

        // Update parent task counts
        setTasks(prev => prev.map(t =>
          t._id === editingTask?._id
            ? {
                ...t,
                subtaskCount: Math.max(0, (t.subtaskCount ?? 1) - 1),
                subtaskCompletedCount: deletedSubtask?.status === "completed"
                  ? Math.max(0, (t.subtaskCompletedCount ?? 1) - 1)
                  : t.subtaskCompletedCount
              }
            : t
        ));
        setEditingTask(prev => prev ? {
          ...prev,
          subtaskCount: Math.max(0, (prev.subtaskCount ?? 1) - 1),
          subtaskCompletedCount: deletedSubtask?.status === "completed"
            ? Math.max(0, (prev.subtaskCompletedCount ?? 1) - 1)
            : prev.subtaskCompletedCount
        } : null);

        toast.success("Subtask deleted");
      }
    } catch {
      toast.error("Failed to delete subtask");
    }
  };

  // Remove a soft-linked task from this parent's checklist without deleting it —
  // it stays a top-level task in the matrix.
  const handleUnlinkSubtask = async (subtask: Task) => {
    const wasCompleted = subtask.status === "completed";
    setSubtasks(prev => prev.filter(s => s._id !== subtask._id));
    setTasks(prev => prev.map(t => {
      if (t._id === subtask._id) return { ...t, linkedParentId: undefined };
      if (t._id === editingTask?._id) {
        return {
          ...t,
          subtaskCount: Math.max(0, (t.subtaskCount ?? 1) - 1),
          subtaskCompletedCount: wasCompleted ? Math.max(0, (t.subtaskCompletedCount ?? 1) - 1) : t.subtaskCompletedCount,
        };
      }
      return t;
    }));
    setEditingTask(prev => prev ? {
      ...prev,
      subtaskCount: Math.max(0, (prev.subtaskCount ?? 1) - 1),
      subtaskCompletedCount: wasCompleted ? Math.max(0, (prev.subtaskCompletedCount ?? 1) - 1) : prev.subtaskCompletedCount,
    } : null);
    try {
      const response = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: subtask._id, linkedParentId: null }),
      });
      if (response.ok) toast.success("Task unlinked");
      else { void fetchTasks(); toast.error("Failed to unlink task"); }
    } catch {
      void fetchTasks();
      toast.error("Failed to unlink task");
    }
  };

  const startEditSubtask = (subtask: Task) => {
    setEditingSubtaskId(subtask._id);
    setEditingSubtaskTitle(subtask.title);
  };

  const cancelEditSubtask = () => {
    setEditingSubtaskId(null);
    setEditingSubtaskTitle("");
  };

  const handleUpdateSubtaskTitle = async (subtaskId: string) => {
    const trimmed = editingSubtaskTitle.trim();
    const current = subtasks.find(s => s._id === subtaskId);
    if (!trimmed || trimmed === current?.title) { cancelEditSubtask(); return; }
    try {
      const response = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: subtaskId, title: trimmed }),
      });
      if (response.ok) {
        const updatedSubtask = await response.json() as Task;
        setSubtasks(prev => prev.map(s => s._id === subtaskId ? updatedSubtask : s));
        cancelEditSubtask();
      } else {
        toast.error("Failed to update subtask");
      }
    } catch {
      toast.error("Error updating subtask");
    }
  };

  const handleCompleteParentTask = async () => {
    if (!editingTask) return;

    try {
      const response = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _id: editingTask._id,
          status: "completed",
        })
      });

      if (response.ok) {
        const updatedTask = await response.json() as Task;
        setTasks(prev => prev.map(t =>
          t._id === editingTask._id ? { ...t, ...updatedTask } : t
        ));
        setEditingTask(prev => prev ? { ...prev, ...updatedTask } : null);
        toast.success("Task completed!");
      }
    } catch {
      toast.error("Failed to complete task");
    }
  };

  const resetFormState = () => {
    setFormData({
      title: "",
      description: "",
      quadrant: "urgent-important",
      priority: "medium",
      dueDate: "",
      dueTime: "12:00",
      duration: "",
      goalId: "",
      linkedParentId: ""
    });
    setEditingTask(null);
  };

  const closeModal = () => {
    void flushAllStepOps();
    setIsModalOpen(false);
    resetFormState();
    setSubtasks([]);
    setNewSubtaskTitle("");
    cancelEditSubtask();
    setNestPickerOpen(false);
    setNestSearch("");
    setNestQuadrantFilter("all");
  };

  const openModalForQuadrant = (quadrant: TaskQuadrant) => {
    setEditingTask(null);
    setFormData({
      title: "",
      description: "",
      quadrant,
      priority: quadrant === "urgent-important" ? "high" : "medium",
      dueDate: "",
      dueTime: "12:00",
      duration: "",
      goalId: "",
      linkedParentId: ""
    });
    setIsModalOpen(true);
  };

  const openTaskForEdit = async (task: Task) => {
    setEditingTask(task);
    const taskDate = task.dueDate ? new Date(task.dueDate) : null;
    setFormData({
      title: task.title,
      description: task.description ?? "",
      quadrant: task.quadrant,
      priority: task.priority,
      dueDate: taskDate ? format(taskDate, "yyyy-MM-dd") : "",
      dueTime: taskDate ? format(taskDate, "HH:mm") : "12:00",
      duration: task.duration ?? "",
      goalId: task.goalId ?? "",
      linkedParentId: task.linkedParentId ?? ""
    });
    setIsModalOpen(true);

    // Fetch subtasks if this is a parent task (not a subtask itself)
    if (!task.parentTaskId && task.subtaskCount !== undefined && task.subtaskCount > 0) {
      setSubtasksLoading(true);
      try {
        const response = await fetch(`/api/tasks/${task._id}/subtasks`);
        if (response.ok) {
          const data = await response.json() as Task[];
          setSubtasks(data);
        }
      } catch {
        toast.error("Failed to load subtasks");
      } finally {
        setSubtasksLoading(false);
      }
    } else {
      setSubtasks([]);
    }
  };

  // searchQuery is shared with the command palette, so a task also matches on the
  // name of a checklist attached to it — otherwise searching a checklist name in
  // the palette blanks the matrix behind it.
  const filteredTasks = tasks.filter(task => {
    const q = searchQuery.toLowerCase();
    return (
      task.title.toLowerCase().includes(q) ||
      (task.description?.toLowerCase().includes(q) ?? false) ||
      (task.checklists ?? []).some(c => c.name.toLowerCase().includes(q))
    );
  });

  const getTasksByQuadrant = (quadrant: TaskQuadrant) =>
    filteredTasks.filter(task => task.quadrant === quadrant);

  // ===== "Calm Editorial" redesign: theming + derived view models =====

  // Drive the token theme: paper background + .dark class, scoped to the dashboard.
  useEffect(() => {
    document.body.classList.add("paper");
    document.body.classList.remove("bg-gray-950", "text-white");
    return () => {
      document.body.classList.remove("paper");
      document.body.classList.add("bg-gray-950", "text-white");
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDarkMode);
  }, [isDarkMode]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  })();
  const firstName = user?.firstName ?? "";

  // Per-quadrant editorial config (name, subtitle, semantic color, index, contextual copy)
  const MATRIX_META: Record<TaskQuadrant, {
    name: string; subtitle: string; color: string; index: string;
    nextLabel: string; addLabel: string; emptyTitle: string; emptySub: string;
  }> = {
    "urgent-important": {
      name: "Do First", subtitle: "Urgent & Important", color: "var(--q-do-first)", index: "01",
      nextLabel: "Next action", addLabel: "Add a task",
      emptyTitle: "Nothing urgent right now.", emptySub: "A clear, calm start to the day.",
    },
    "important-not-urgent": {
      name: "Schedule", subtitle: "Important & Not Urgent", color: "var(--q-schedule)", index: "02",
      nextLabel: "Next action", addLabel: "Add a task",
      emptyTitle: "Nothing scheduled yet.", emptySub: "Plan what matters before it turns urgent.",
    },
    "urgent-not-important": {
      name: "Delegate", subtitle: "Urgent & Not Important", color: "var(--q-delegate)", index: "03",
      nextLabel: "Next action", addLabel: "Add a task to hand off",
      emptyTitle: "Nothing to hand off.", emptySub: "You're holding only what's yours.",
    },
    "not-urgent-not-important": {
      name: "Eliminate", subtitle: "Not Urgent & Not Important", color: "var(--q-eliminate)", index: "04",
      nextLabel: "Let go of", addLabel: "Add a task to drop",
      emptyTitle: "Nothing to drop.", emptySub: "No busywork cluttering your day.",
    },
  };
  const MATRIX_ORDER: TaskQuadrant[] = [
    "urgent-important", "important-not-urgent", "urgent-not-important", "not-urgent-not-important",
  ];

  // A quadrant's visible tasks in display order. A manual sortOrder (set by the
  // reorder controls) takes priority — "manual order wins"; tasks without one
  // fall back to overdue → earliest due date → oldest created.
  const getOrderedQuadrantTasks = (quadrant: TaskQuadrant) => {
    return [...getTasksByQuadrant(quadrant)].sort((a, b) => {
      // Completed tasks stay visible but sink below all live work.
      const aDone = a.status === "completed";
      const bDone = b.status === "completed";
      if (aDone !== bDone) return aDone ? 1 : -1;
      // Scheduled tasks (with a due date) always lead; unscheduled sink to the
      // bottom — they still need a date.
      const aSched = !!a.dueDate;
      const bSched = !!b.dueDate;
      if (aSched !== bSched) return aSched ? -1 : 1;
      // Scheduled tasks read strictly by date, soonest first (overdue dates are
      // in the past, so they surface at the top naturally).
      if (aSched) return new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime();
      // Unscheduled tasks have no date to order by, so a manual sortOrder wins.
      const ao = a.sortOrder ?? Infinity;
      const bo = b.sortOrder ?? Infinity;
      if (ao !== bo) return ao - bo;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  };

  // Persist the per-quadrant next-action choice (a pinned task id, or cleared).
  const setNextActionFor = (quadrant: TaskQuadrant, value: string | undefined) => {
    setNextActionChoice(prev => {
      const next = { ...prev };
      if (value === undefined) delete next[quadrant];
      else next[quadrant] = value;
      safeSetItem(NEXT_ACTION_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Split a quadrant's ordered tasks into the single "next action" + the "up next"
  // list. An explicit choice wins: a pinned task becomes the headline, and a
  // cleared quadrant deliberately shows no next action.
  const getQuadrantView = (quadrant: TaskQuadrant) => {
    const sorted = getOrderedQuadrantTasks(quadrant);
    const choice = nextActionChoice[quadrant];
    if (choice === NEXT_ACTION_CLEARED) {
      return { nextAction: undefined as Task | undefined, upNext: sorted, cleared: sorted.length > 0 };
    }
    const pinnedIdx = choice ? sorted.findIndex(t => t._id === choice && t.status !== "completed") : -1;
    // Otherwise prefer the first incomplete task as the headline "next action"
    const headlineIdx = pinnedIdx !== -1 ? pinnedIdx : sorted.findIndex(t => t.status !== "completed");
    const idx = headlineIdx === -1 ? 0 : headlineIdx;
    const nextAction = sorted[idx];
    const upNext = sorted.filter((_, i) => i !== idx);
    return { nextAction, upNext, cleared: false };
  };

  // Give an unscheduled task a due date in one tap (defaults to 9am).
  const handleQuickSchedule = async (task: Task, when: "today" | "tomorrow" | "nextWeek") => {
    const base = when === "today" ? new Date() : when === "tomorrow" ? addDays(new Date(), 1) : addDays(new Date(), 7);
    const due = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0, 0, 0);
    const iso = due.toISOString();
    setTasks(prev => prev.map(t => t._id === task._id ? { ...t, dueDate: iso } : t));
    try {
      const res = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: task._id, dueDate: iso }),
      });
      if (res.ok) {
        const updated = await res.json() as Task;
        setTasks(prev => prev.map(t => t._id === updated._id ? { ...t, ...updated } : t));
        toast.success(`Scheduled for ${format(due, "MMM d")}`);
      } else {
        void fetchTasks();
        toast.error("Failed to schedule task");
      }
    } catch {
      void fetchTasks();
      toast.error("Failed to schedule task");
    }
  };

  // Promote a task to be the quadrant's headline. Pinned explicitly, since
  // scheduled tasks are ordered by date and can't be moved by sortOrder.
  // Open Settings with every draft reset to the saved values.
  const openSettings = (section: SettingsSection) => {
    setSettingsKeyInput(geminiApiKey); setDraftAnthropicKey(anthropicApiKey); setLocationInput(weatherLocation);
    setDraftIcalUrls(icalUrls); setSettingsIcalInput(""); setSettingsIcalError(""); setDraftAutoArchive(autoArchiveCompleted);
    setDraftFinanceUrl(financeApiUrl); setDraftFinanceKey(financeApiKey); setDraftFinanceUserId(financeUserId); setFinanceTestResult(null);
    setDraftMyndlistUrl(myndlistApiUrl); setDraftMyndlistKey(myndlistApiKey); setMyndlistTestResult(null);
    setSettingsSection(section); void fetchArchivedTasks(); setIsSettingsOpen(true);
  };

  // Apply one assistant suggestion through the same paths the matrix uses.
  const handleApplySuggestion = async (s: AssistantSuggestion): Promise<boolean> => {
    const task = tasks.find(t => t._id === s.taskId);
    if (!task) {
      toast.error("That task changed or no longer exists");
      return false;
    }
    if (s.action === "move_to_top") {
      await handleReorderTask(task, "top");
      return true;
    }
    let body: Record<string, unknown>;
    switch (s.action) {
      case "archive":
        body = { archived: true };
        break;
      case "move_quadrant": {
        const quadrant = s.value as TaskQuadrant;
        // Same rule as the task form: Do First is always high priority.
        body = quadrant === "urgent-important" ? { quadrant, priority: "high" } : { quadrant };
        break;
      }
      case "set_priority":
        body = { priority: s.value };
        break;
      case "set_due_date": {
        // 9:00 local on that day, like the quick-schedule menu.
        const [y = 0, m = 1, d = 1] = s.value.split("-").map(Number);
        body = { dueDate: new Date(y, m - 1, d, 9, 0, 0, 0).toISOString() };
        break;
      }
      case "link_goal":
        body = { goalId: s.value };
        break;
      default:
        return false;
    }
    try {
      const res = await fetch("/api/tasks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ _id: task._id, ...body }),
      });
      if (!res.ok) {
        toast.error("Couldn't apply that suggestion");
        return false;
      }
      if (s.action === "archive") {
        setTasks(prev => prev.filter(t => t._id !== task._id));
      } else {
        const updated = await res.json() as Task;
        setTasks(prev => prev.map(t => t._id === updated._id ? { ...t, ...updated } : t));
      }
      return true;
    } catch {
      toast.error("Couldn't apply that suggestion");
      return false;
    }
  };

  const handleMakeNextAction = (task: Task) => {
    setNextActionFor(task.quadrant, task._id);
  };

  // Step the headline down: clear the quadrant's next action, leaving it empty
  // until one is picked again.
  const handleDemoteNextAction = (quadrant: TaskQuadrant) => {
    setNextActionFor(quadrant, NEXT_ACTION_CLEARED);
  };

  // Reorder a task within its quadrant (unscheduled tasks only — dated ones
  // follow their due date).
  const handleReorderTask = async (task: Task, dir: "up" | "down" | "top") => {
    const ordered = getOrderedQuadrantTasks(task.quadrant);
    const idx = ordered.findIndex(t => t._id === task._id);
    if (idx === -1) return;
    const arr = [...ordered];
    if (dir === "top") {
      if (idx === 0) return;
      arr.splice(idx, 1);
      arr.unshift(task);
    } else if (dir === "up") {
      if (idx === 0) return;
      [arr[idx - 1], arr[idx]] = [arr[idx]!, arr[idx - 1]!];
    } else {
      if (idx === arr.length - 1) return;
      [arr[idx + 1], arr[idx]] = [arr[idx]!, arr[idx + 1]!];
    }
    await saveQuadrantOrder(arr);
  };

  // Drag-to-reorder for the "Up next" rows. Only unscheduled, open tasks can be
  // picked up or dropped on, so a move never leaves that block of the quadrant.
  const taskSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleTaskDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const task = tasks.find(t => t._id === active.id);
    if (!task) return;
    // Move within the full ordered quadrant (headline included), so the next
    // action keeps its slot whether it was pinned or auto-picked.
    const ordered = getOrderedQuadrantTasks(task.quadrant);
    const from = ordered.findIndex(t => t._id === active.id);
    const to = ordered.findIndex(t => t._id === over.id);
    if (from === -1 || to === -1) return;
    void saveQuadrantOrder(arrayMove(ordered, from, to));
  };

  // Save a quadrant's order as manual sort positions: shown at once, then
  // persisted; a failed save reloads the real order.
  const saveQuadrantOrder = async (arr: Task[]) => {
    const items = arr.map((t, i) => ({ id: t._id, sortOrder: i }));
    const orderMap = new Map(items.map(it => [it.id, it.sortOrder]));
    setTasks(prev => prev.map(t => orderMap.has(t._id) ? { ...t, sortOrder: orderMap.get(t._id) } : t));
    try {
      const res = await fetch("/api/tasks/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) void fetchTasks();
    } catch {
      void fetchTasks();
    }
  };

  const isTaskOverdue = (task: Task) =>
    !!task.dueDate && task.status !== "completed" && new Date(task.dueDate) < startOfDay(new Date());

  // Title of the task this one is soft-linked under (shown as a matrix hint), if any.
  const linkedParentTitle = (task: Task) =>
    task.linkedParentId ? tasks.find(t => t._id === task.linkedParentId)?.title : undefined;

  // The Schedule quadrant is the one whose whole point is giving important work a
  // date, so the "needs scheduling" nudge is scoped to it.
  const SCHEDULE_QUADRANT: TaskQuadrant = "important-not-urgent";

  // Red "Schedule" pill for Schedule-quadrant tasks without a due date —
  // a nudge that they still need to be scheduled. One tap sets a date.
  const renderScheduleButton = (task: Task, size: "sm" | "md" = "sm") => (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className={cn(
            "shrink-0 inline-flex items-center gap-[4px] rounded-[6px] outline-none transition-colors",
            size === "md" ? "text-[11px] px-[8px] py-[3px]" : "text-[10.5px] px-[7px] py-[2px]"
          )}
          style={{ color: "var(--tag-fg)", background: "var(--tag-bg)" }}
          title="Schedule this task"
        >
          <CalendarPlus className={size === "md" ? "w-[12px] h-[12px]" : "w-[11px] h-[11px]"} />
          Schedule
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={5}
          className="min-w-[160px] rounded-lg p-1.5 shadow-lg z-[200] bg-[var(--drawer)] border border-[var(--drawer-bd)]">
          {([
            ["today", "Today"],
            ["tomorrow", "Tomorrow"],
            ["nextWeek", "Next week"],
          ] as const).map(([when, label]) => (
            <DropdownMenu.Item key={when} onSelect={() => void handleQuickSchedule(task, when)}
              className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer outline-none hover:bg-[var(--hover)] text-[var(--ink2)]">
              <CalendarDays className="w-4 h-4" style={{ color: "var(--muted2)" }} />
              {label}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="h-px my-1 bg-[var(--line3)]" />
          <DropdownMenu.Item onSelect={() => void openTaskForEdit(task)}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer outline-none hover:bg-[var(--hover)] text-[var(--ink2)]">
            <Calendar className="w-4 h-4" style={{ color: "var(--muted2)" }} />
            Pick a date…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  // Small "i" affordance on a routine row — click to read that item's description.
  const renderDescriptionInfo = (title: string, description: string) => (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button onClick={(e) => e.stopPropagation()} title="Show details"
          className="shrink-0 p-0.5 rounded outline-none opacity-50 hover:opacity-100 transition-opacity"
          style={{ color: "var(--muted2)" }}>
          <Info className="w-[13px] h-[13px]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6}
          className="max-w-[280px] rounded-[11px] p-3 shadow-lg z-[200] bg-[var(--drawer)] border border-[var(--drawer-bd)]">
          <div className="text-[12.5px] font-semibold mb-1" style={{ color: "var(--ink)" }}>{title}</div>
          <div className="text-[12.5px] whitespace-pre-wrap" style={{ color: "var(--ink3)" }}>{description}</div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  // Compact duration label for the matrix rows, e.g. 30 → "30m", 90 → "1h30".
  const formatShortDuration = (min?: number): string | null => {
    if (!min || min <= 0) return null;
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h${m}` : `${h}h`;
  };

  // Masthead focus stack: the active goals in play right now across all periods
  // (this week/month/year, plus any custom goal whose window includes today),
  // ordered by horizon. We surface the first few and link to the rest.
  const FOCUS_STACK_LIMIT = 3;
  const focusPeriodLabel: Record<GoalPeriodType, string> = { week: "Week", month: "Month", year: "Year", custom: "Custom" };
  // Length of a custom goal's window in days, or null if not a dated custom goal.
  const goalDurationDays = (goal: Goal): number | null => {
    if (goal.periodType !== "custom" || !goal.startDate || !goal.endDate) return null;
    return Math.round((new Date(goal.endDate).getTime() - new Date(goal.startDate).getTime()) / 86400000);
  };
  // Period tag for the focus stack — custom goals show their length ("90 days").
  const goalTagLabel = (goal: Goal): string => {
    const days = goalDurationDays(goal);
    return days !== null ? `${days} days` : focusPeriodLabel[goal.periodType];
  };
  const activeFocusGoals = (() => {
    const today = format(new Date(), "yyyy-MM-dd");
    const order: Record<GoalPeriodType, number> = { week: 0, month: 1, year: 2, custom: 3 };
    return goals
      .filter(g => g.status === "active" && (
        (g.periodType === "week" && g.periodKey === currentWeekKey) ||
        (g.periodType === "month" && g.periodKey === currentMonthKey) ||
        (g.periodType === "year" && g.periodKey === currentYearKey) ||
        (g.periodType === "custom" && (g.startDate ?? "") <= today && (g.endDate ?? "") >= today)
      ))
      .sort((a, b) => order[a.periodType] - order[b.periodType]);
  })();
  // If any current goals are starred, the stack shows only those; otherwise it
  // falls back to the smart auto-selection so the masthead is never empty.
  const pinnedFocusGoals = activeFocusGoals.filter(g => g.pinned);
  const focusSource = pinnedFocusGoals.length > 0 ? pinnedFocusGoals : activeFocusGoals;
  const focusGoals = focusSource.slice(0, FOCUS_STACK_LIMIT);
  const focusMoreCount = focusSource.length - focusGoals.length;

  // Weather summary for the masthead line
  const weatherSummary = weatherData
    ? {
        temp: Math.round(weatherData.temp),
        label: WEATHER_CODE_MAP[weatherData.weatherCode]?.label ?? "—",
        feels: Math.round(weatherData.feelsLike),
      }
    : null;

  // Payments summary for the slim due-bar
  const paymentsDateIsToday = paymentsDate === todayYmd();

  // Day picker for the payments strip. Every value here is a "yyyy-MM-dd"
  // string: the native date input reads and writes local calendar dates
  // directly, and shiftYmd stays in local time, so nothing can slip a day.
  const renderPaymentsDateNav = () => (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setPaymentsDate(shiftYmd(paymentsDate, -1))}
        aria-label="Previous day"
        title="Previous day"
        className="w-[22px] h-[22px] rounded-[7px] flex items-center justify-center text-[13px] leading-none"
        style={{ background: "var(--chip)", color: "var(--muted5)" }}
      >
        ‹
      </button>

      <label className="relative flex items-center">
        <span
          className="text-[12px] px-1.5 cursor-pointer whitespace-nowrap"
          style={{ color: paymentsDateIsToday ? "var(--muted)" : "var(--ink3)" }}
        >
          {paymentsDateIsToday ? "Today" : format(parseYmd(paymentsDate), "EEE, MMM d")}
        </span>
        <input
          type="date"
          value={paymentsDate}
          onChange={(e) => { if (e.target.value) setPaymentsDate(e.target.value); }}
          aria-label="Show payments for a specific date"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        />
      </label>

      <button
        onClick={() => setPaymentsDate(shiftYmd(paymentsDate, 1))}
        aria-label="Next day"
        title="Next day"
        className="w-[22px] h-[22px] rounded-[7px] flex items-center justify-center text-[13px] leading-none"
        style={{ background: "var(--chip)", color: "var(--muted5)" }}
      >
        ›
      </button>

      {!paymentsDateIsToday && (
        <button
          onClick={() => setPaymentsDate(todayYmd())}
          className="text-[11.5px] font-semibold ml-1"
          style={{ color: "var(--accent)" }}
        >
          Today
        </button>
      )}
    </div>
  );

  const paymentsSummary = (() => {
    if (!paymentsData?.configured) return null;
    const accounts = paymentsData.accounts ?? [];
    const budgets = paymentsData.budgets ?? [];
    const budgetTotal = budgets.reduce((s, b) => s + b.amount, 0);
    const totalDue = Math.abs(accounts.reduce((s, a) => s + a.total, 0) + budgetTotal);
    const count = accounts.length + budgets.length;
    const income = paymentsData.totalIncome ?? 0;
    const dayEnds = paymentsData.finalBalance ?? income - totalDue;
    return { totalDue, count, income, dayEnds, hasDue: count > 0 };
  })();

  const fmtMoney = (n: number) =>
    `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="min-h-screen" style={{ color: "var(--ink)" }}>
      {/* ===== Masthead ===== */}
      <div className="mx-auto max-w-[1320px] px-5 md:px-10 pt-6 md:pt-8">
        {/* top bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-7">
          <div className="flex items-baseline gap-4">
            <span style={{ fontFamily: "var(--font-serif)" }} className="text-[28px] font-medium leading-none">EisenQ</span>
            <span className="text-[12px] tracking-[0.14em] uppercase" style={{ color: "var(--muted)" }}>Decide &amp; Do</span>
          </div>
          <div className="flex items-center gap-3 flex-1 md:flex-none justify-end">
            <button
              onClick={() => { setSearchOpen(true); void fetchMyndlistTemplates(); }}
              className="searchbar flex items-center gap-2 flex-1 md:flex-none md:w-[280px] px-4 py-[9px] rounded-[11px] text-left cursor-text"
              style={{ background: "var(--drawer)", border: "1px solid var(--field-bd)" }}
            >
              <Search className="w-4 h-4" style={{ color: "var(--muted)" }} />
              <span className="text-[13px] flex-1 truncate" style={{ color: searchQuery ? "var(--ink)" : "var(--muted)" }}>
                {searchQuery || "Search tasks…"}
              </span>
              {searchQuery && (
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); setSearchQuery(""); }}
                  className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{ background: "var(--chip)", color: "var(--muted)" }}
                >
                  clear
                </span>
              )}
            </button>
            <div className="flex gap-1">
              {anthropicApiKey && (
                <button className="navbtn" onClick={() => setIsAssistantOpen(true)} title="Assistant">
                  <Sparkles className="w-[17px] h-[17px]" />
                </button>
              )}
              <button className="navbtn" onClick={() => setIsCalendarDrawerOpen(true)} title="Today's calendar">
                <CalendarDays className="w-[17px] h-[17px]" />
              </button>
              <button className="navbtn" onClick={() => openChecklistLibrary()} title="Checklist library">
                <ListChecks className="w-[17px] h-[17px]" />
              </button>
              <button className="navbtn" onClick={() => setIsInfoModalOpen(true)} title="About the matrix"
                style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: "18px" }}>
                i
              </button>
              <button className="navbtn" onClick={() => {
                const newValue = !isDarkMode;
                setDarkMode(newValue);
                localStorage.setItem("eisenq-dark-mode", String(newValue));
              }} title="Toggle theme">
                {isDarkMode ? <Sun className="w-[17px] h-[17px]" /> : <Moon className="w-[17px] h-[17px]" />}
              </button>
              <button className="navbtn" onClick={() => openSettings("tasks")} title="Settings">
                <Settings className="w-[17px] h-[17px]" />
              </button>
              <UserButton
                afterSignOutUrl="/sign-in"
                appearance={{ elements: { avatarBox: "w-[38px] h-[38px] rounded-[11px]" } }}
              />
            </div>
          </div>
        </div>

        {/* greeting + weather line + this week's focus */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-5 md:gap-10 mb-[22px] pb-[22px]"
          style={{ borderBottom: "1px solid var(--line)" }}>
          <div>
            <div style={{ fontFamily: "var(--font-serif)" }} className="text-[27px] md:text-[34px] font-normal leading-[1.1]">
              {greeting}{firstName ? `, ${firstName}` : ""}.
            </div>
            <div className="text-[14px] mt-1.5" style={{ color: "var(--muted)" }}>
              {format(new Date(), "EEEE, MMMM d")} · here&apos;s what deserves your attention today.
            </div>
            {weatherSummary && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-3 text-[13px]" style={{ color: "var(--muted5)" }}>
                <span className="flex items-center gap-1.5">
                  <Cloud className="w-[15px] h-[15px]" />
                  <span style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[17px] leading-none">
                    {weatherSummary.temp}°
                  </span>
                  {weatherSummary.label} · feels {weatherSummary.feels}°
                </span>
                {clothingSuggestion && (
                  <>
                    <span className="w-[3px] h-[3px] rounded-full" style={{ background: "var(--muted6)" }} />
                    <span>
                      <span className="text-[10px] tracking-[0.1em] uppercase" style={{ color: "var(--muted2)" }}>Wear</span>
                      &nbsp;&nbsp;{clothingSuggestion}
                    </span>
                  </>
                )}
                <span className="w-[3px] h-[3px] rounded-full" style={{ background: "var(--muted6)" }} />
                <span className="flex items-center gap-1.5"><MapPin className="w-[13px] h-[13px]" />{weatherLocation}</span>
              </div>
            )}
          </div>
          {/* in focus — active goals across all periods */}
          <div className="md:text-right md:shrink-0 md:pt-2 md:min-w-[240px]">
            <div className="text-[10px] tracking-[0.14em] uppercase mb-[9px]" style={{ color: "var(--muted2)" }}>In focus</div>
            {focusGoals.length > 0 ? (
              <div className="flex flex-col gap-[13px]">
                {focusGoals.map((goal) => {
                  const counts = goalTaskCounts.get(goal._id);
                  return (
                    <div key={goal._id} onClick={() => setIsGoalsExpanded(true)} className="cursor-pointer">
                      <div className="flex items-baseline gap-2 md:justify-end">
                        <span className="text-[9px] tracking-[0.1em] uppercase shrink-0" style={{ color: "var(--muted3)" }}>{goalTagLabel(goal)}</span>
                        <span style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[17px] leading-[1.2]">{goal.title}</span>
                      </div>
                      {counts && counts.total > 0 && (
                        <div className="flex items-center gap-2 md:justify-end mt-[6px]">
                          <div className="w-[80px] h-[4px] rounded-full overflow-hidden" style={{ background: "var(--line3)" }}>
                            <div className="h-full" style={{ width: `${(counts.done / counts.total) * 100}%`, background: "var(--pill-active)" }} />
                          </div>
                          <span className="text-[11px]" style={{ color: "var(--muted)" }}>{counts.done} / {counts.total}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="flex items-center gap-3 md:justify-end">
                  {focusMoreCount > 0 && (
                    <button onClick={() => setIsGoalsExpanded(true)} className="text-[12px] font-semibold" style={{ color: "var(--accent)" }}>
                      +{focusMoreCount} more
                    </button>
                  )}
                  <button onClick={() => { setShowUnfinishedGoals(false); setIsGoalsExpanded(true); }}
                    className="text-[12px] font-semibold inline-flex items-center gap-1.5" style={{ color: "var(--accent)" }}>
                    Manage goals ›
                    {pastUnfinishedGoals.length > 0 && (
                      <span className="text-[10px] rounded-full px-[6px] py-px" style={{ background: "var(--chip)", color: "var(--muted5)" }}>
                        {pastUnfinishedGoals.length} unfinished
                      </span>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div onClick={() => setIsGoalsExpanded(true)} style={{ fontFamily: "var(--font-serif)", color: "var(--muted3)" }}
                  className="text-[19px] leading-[1.25] cursor-pointer">
                  No goal set yet
                </div>
                <button onClick={() => setIsGoalsExpanded(true)} className="inline-block mt-[9px] text-[12.5px] font-semibold" style={{ color: "var(--accent)" }}>
                  + Add a focus ›
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Calendar Planning Drawer */}
      <AssistantPanel
        open={isAssistantOpen}
        onOpenChange={setIsAssistantOpen}
        onApply={handleApplySuggestion}
        onOpenSettings={() => { setIsAssistantOpen(false); openSettings("greeting"); }}
      />

      <Dialog.Root open={isCalendarDrawerOpen} onOpenChange={setIsCalendarDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <Dialog.Content
            className={cn(
              "fixed right-0 top-0 h-full w-full max-w-2xl z-50 shadow-xl",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
              "duration-300 ease-in-out",
              "bg-[var(--drawer)] text-[var(--ink)]"
            )}
          >
            <div className="flex flex-col h-full">
              {/* Drawer Header */}
              <div className={cn("flex items-center justify-between p-4 border-b", "border-[var(--drawer-bd)]")}>
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-[#7f6a45]/20">
                    <CalendarDays className="w-5 h-5 text-[var(--accent)]" />
                  </div>
                  <div>
                    <Dialog.Title className="text-lg font-semibold">Task Planning</Dialog.Title>
                    <Dialog.Description className={cn("text-sm", "text-[var(--ink3)]")}>
                      Schedule and organize your tasks
                    </Dialog.Description>
                  </div>
                </div>
                <Dialog.Close asChild>
                  <button
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      "hover:bg-[var(--hover)] text-[var(--ink3)]"
                    )}
                  >
                    <X className="w-5 h-5" />
                  </button>
                </Dialog.Close>
              </div>

              {/* View Tabs */}
              <div className={cn("p-4 border-b", "border-[var(--drawer-bd)]")}>
                <div className={cn("flex rounded-lg p-1", "bg-[var(--chip)]")}>
                  <button
                    onClick={() => setCalendarView("day")}
                    className={cn(
                      "flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2",
                      calendarView === "day"
                        ? "bg-[var(--btn-primary)] text-[var(--btn-fg)]"
                        : "text-[var(--ink3)] hover:text-[var(--ink)]"
                    )}
                  >
                    <Clock className="w-4 h-4" />
                    My Day
                  </button>
                  <button
                    onClick={() => setCalendarView("week")}
                    className={cn(
                      "flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2",
                      calendarView === "week"
                        ? "bg-[var(--btn-primary)] text-[var(--btn-fg)]"
                        : "text-[var(--ink3)] hover:text-[var(--ink)]"
                    )}
                  >
                    <CalendarRange className="w-4 h-4" />
                    My Week
                  </button>
                  <button
                    onClick={() => setCalendarView("month")}
                    className={cn(
                      "flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors flex items-center justify-center gap-2",
                      calendarView === "month"
                        ? "bg-[var(--btn-primary)] text-[var(--btn-fg)]"
                        : "text-[var(--ink3)] hover:text-[var(--ink)]"
                    )}
                  >
                    <Calendar className="w-4 h-4" />
                    My Month
                  </button>
                </div>
              </div>

              {/* Scrollable Content */}
              <div className="flex-1 overflow-y-auto p-4">
                {/* Navigation */}
                <div className="flex items-center justify-between mb-4">
                  <button
                    onClick={() => navigateCalendar("prev")}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      "hover:bg-[var(--hover)] text-[var(--ink3)]"
                    )}
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <div className="text-center">
                    <h3 className="font-semibold text-lg flex items-center justify-center gap-2">
                      {calendarView === "day" && format(selectedDate, "EEEE, MMMM d, yyyy")}
                      {calendarView === "week" && `${format(startOfWeek(selectedDate), "MMM d")} - ${format(endOfWeek(selectedDate), "MMM d, yyyy")}`}
                      {calendarView === "month" && format(selectedDate, "MMMM yyyy")}
                      {planningLoading && <Loader2 className="w-4 h-4 animate-spin text-[var(--muted)]" />}
                    </h3>
                    {isToday(selectedDate) && calendarView === "day" && (
                      <span className="text-xs text-[var(--accent)] font-medium">Today</span>
                    )}
                  </div>
                  <button
                    onClick={() => navigateCalendar("next")}
                    className={cn(
                      "p-2 rounded-lg transition-colors",
                      "hover:bg-[var(--hover)] text-[var(--ink3)]"
                    )}
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </div>

                {/* My Day View */}
                {calendarView === "day" && (() => {
                  const dayTasks = getTasksForDate(selectedDate);
                  const dayEvents = getEventsForDate(selectedDate);
                  const showEventSkeleton = planningLoading && icalUrls.length > 0;
                  return (
                  <div className="space-y-3">
                    {!showEventSkeleton && dayTasks.length === 0 && dayEvents.length === 0 ? (
                      <div className={cn("text-center py-12 rounded-lg", "bg-[var(--tint)]")}>
                        <CalendarDays className={cn("w-12 h-12 mx-auto mb-3", "text-[var(--muted)]")} />
                        <p className={cn("text-sm", "text-[var(--ink3)]")}>
                          No tasks scheduled for this day
                        </p>
                        <p className={cn("text-xs mt-1", "text-[var(--muted)]")}>
                          Add tasks with due dates to see them here
                        </p>
                      </div>
                    ) : (
                      <>
                      {showEventSkeleton && [1, 2, 3].map((i) => (
                        <div
                          key={`event-skeleton-${i}`}
                          className={cn(
                            "flex items-start gap-4 p-4 rounded-lg border-l-4 border-l-[var(--field-bd)]",
                            "bg-[var(--tint)]"
                          )}
                        >
                          <div className={cn("h-7 w-16 rounded-lg animate-pulse flex-shrink-0", "bg-[var(--line3)]")} />
                          <div className="flex-1 space-y-2">
                            <div className={cn("h-4 w-1/2 rounded animate-pulse", "bg-[var(--line3)]")} />
                            <div className={cn("h-3 w-24 rounded animate-pulse", "bg-[var(--line3)]")} />
                          </div>
                        </div>
                      ))}
                      {!showEventSkeleton && dayEvents.map((ev) => (
                        <div
                          key={ev.id}
                          className={cn(
                            "flex items-start gap-4 p-4 rounded-lg border-l-4 border-l-[var(--accent)]",
                            "bg-[var(--tint)]"
                          )}
                        >
                          <div className={cn(
                            "flex-shrink-0 px-3 py-1 rounded-lg text-sm font-medium",
                            "bg-[var(--field)] border border-[var(--field-bd)]"
                          )}>
                            {ev.allDay ? "All day" : format(new Date(ev.start), "HH:mm")}
                          </div>
                          <div className="flex-1">
                            <h4 className="font-medium flex items-center gap-1.5">
                              <Calendar className="w-3.5 h-3.5 text-[var(--accent)] flex-shrink-0" />
                              {ev.title}
                            </h4>
                            {ev.location && (
                              <p className={cn("text-sm mt-1", "text-[var(--ink3)]")}>
                                {ev.location}
                              </p>
                            )}
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded mt-2 bg-[#7f6a45]/15 text-[var(--accent)]">
                              <Calendar className="w-3 h-3" />
                              {ev.calendar}
                            </span>
                          </div>
                        </div>
                      ))}
                      {dayTasks.map((task) => (
                        <div
                          key={task._id}
                          onClick={() => openCalendarTaskForEdit(task)}
                          className={cn(
                            "flex items-start gap-4 p-4 rounded-lg border-l-4 transition-colors cursor-pointer",
                            task.quadrant === "urgent-important" && "border-l-red-500",
                            task.quadrant === "important-not-urgent" && "border-l-yellow-500",
                            task.quadrant === "urgent-not-important" && "border-l-blue-500",
                            task.quadrant === "not-urgent-not-important" && "border-l-green-500",
                            "bg-[var(--tint)] hover:bg-[var(--hover)]"
                          )}
                        >
                          <div className={cn(
                            "flex-shrink-0 px-3 py-1 rounded-lg text-sm font-medium",
                            "bg-[var(--field)] border border-[var(--field-bd)]"
                          )}>
                            {task.dueDate ? format(new Date(task.dueDate), "HH:mm") : "--:--"}
                          </div>
                          <div className="flex-1">
                            <h4 className="font-medium">{task.title}</h4>
                            <p className={cn("text-sm mt-1", "text-[var(--ink3)]")}>
                              {task.description}
                            </p>
                            <div className="flex items-center gap-3 mt-2">
                              <span className={cn(
                                "text-xs px-2 py-1 rounded",
                                task.priority === "high"
                                  ? "bg-red-500/20 text-red-400"
                                  : task.priority === "medium"
                                  ? "bg-yellow-500/20 text-yellow-400"
                                  : "bg-green-500/20 text-green-400"
                              )}>
                                {task.priority}
                              </span>
                              {task.duration && (
                                <span className={cn("text-xs", "text-[var(--muted)]")}>
                                  {task.duration} min
                                </span>
                              )}
                              {task.subtaskCount !== undefined && task.subtaskCount > 0 && (
                                <span className={cn(
                                  "text-xs flex items-center gap-1",
                                  task.subtaskCompletedCount === task.subtaskCount
                                    ? "text-green-500"
                                    : "text-[var(--muted)]"
                                )}>
                                  <CheckCircle2 className="w-3 h-3" />
                                  {task.subtaskCompletedCount}/{task.subtaskCount}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      </>
                    )}
                  </div>
                  );
                })()}

                {/* My Week View */}
                {calendarView === "week" && (
                  <div className="grid grid-cols-7 gap-2">
                    {/* Day headers */}
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                      <div key={day} className={cn("text-center text-xs font-medium py-2", "text-[var(--muted)]")}>
                        {day}
                      </div>
                    ))}
                    {/* Week days */}
                    {getWeekDays().map((day) => {
                      const dayTasks = getTasksForDate(day);
                      const dayEvents = getEventsForDate(day);
                      const shownEvents = dayEvents.slice(0, 2);
                      const shownTasks = dayTasks.slice(0, 3);
                      const overflow = (dayEvents.length - shownEvents.length) + (dayTasks.length - shownTasks.length);
                      return (
                        <div
                          key={day.toISOString()}
                          onClick={() => {
                            setSelectedDate(day);
                            setCalendarView("day");
                          }}
                          className={cn(
                            "min-h-[120px] p-2 rounded-lg cursor-pointer transition-colors border",
                            isToday(day) && "ring-2 ring-[var(--pill-active)]",
                            "bg-[var(--tint)] border-[var(--field-bd)] hover:bg-[var(--hover)]"
                          )}
                        >
                          <div className={cn(
                            "text-sm font-medium mb-2",
                            isToday(day) ? "text-[var(--accent)]" : "text-[var(--ink2)]"
                          )}>
                            {format(day, "d")}
                          </div>
                          <div className="space-y-1">
                            {shownEvents.map((ev) => (
                              <div
                                key={ev.id}
                                data-tooltip={`${ev.allDay ? "All day" : format(new Date(ev.start), "HH:mm")} - ${ev.title} (${ev.calendar})`}
                                className="tooltip-task text-xs p-1.5 rounded truncate bg-[#7f6a45]/15 text-[var(--accent)]"
                              >
                                {ev.allDay ? "" : format(new Date(ev.start), "HH:mm") + " "}{ev.title}
                              </div>
                            ))}
                            {shownTasks.map((task) => (
                              <div
                                key={task._id}
                                data-tooltip={`${task.dueDate ? format(new Date(task.dueDate), "HH:mm") + " - " : ""}${task.title}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openCalendarTaskForEdit(task);
                                }}
                                className={cn(
                                  "tooltip-task text-xs p-1.5 rounded truncate cursor-pointer hover:opacity-80 transition-opacity",
                                  task.quadrant === "urgent-important" && "bg-red-500/20 text-red-400",
                                  task.quadrant === "important-not-urgent" && "bg-yellow-500/20 text-yellow-400",
                                  task.quadrant === "urgent-not-important" && "bg-blue-500/20 text-[var(--accent)]",
                                  task.quadrant === "not-urgent-not-important" && "bg-green-500/20 text-green-400"
                                )}
                              >
                                {task.dueDate ? format(new Date(task.dueDate), "HH:mm") : ""} {task.title}
                              </div>
                            ))}
                            {overflow > 0 && (
                              <div className={cn("text-xs", "text-[var(--muted)]")}>
                                +{overflow} more
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* My Month View */}
                {calendarView === "month" && (
                  <div>
                    {/* Day headers */}
                    <div className="grid grid-cols-7 gap-1 mb-2">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                        <div key={day} className={cn("text-center text-xs font-medium py-2", "text-[var(--muted)]")}>
                          {day}
                        </div>
                      ))}
                    </div>
                    {/* Month days */}
                    <div className="grid grid-cols-7 gap-1">
                      {getMonthDays().map((day, index) => {
                        const dayTasks = getTasksForDate(day);
                        const dayEvents = getEventsForDate(day);
                        const isCurrentMonth = isSameMonth(day, selectedDate);
                        return (
                          <div
                            key={index}
                            onClick={() => {
                              setSelectedDate(day);
                              setCalendarView("day");
                            }}
                            className={cn(
                              "min-h-[80px] p-1.5 rounded-lg cursor-pointer transition-colors border",
                              isToday(day) && "ring-2 ring-[var(--pill-active)]",
                              !isCurrentMonth && "opacity-40",
                              darkMode
                                ? "bg-[var(--tint)] border-[var(--field-bd)] hover:bg-[var(--hover)]"
                                : "bg-[var(--tint)] border-[var(--field-bd)] hover:bg-[var(--hover)]"
                            )}
                          >
                            <div className={cn(
                              "text-xs font-medium mb-1",
                              isToday(day) ? "text-[var(--accent)]" : "text-[var(--ink2)]"
                            )}>
                              {format(day, "d")}
                            </div>
                            <div className="space-y-0.5">
                              {dayEvents.slice(0, 1).map((ev) => (
                                <div
                                  key={ev.id}
                                  data-tooltip={`${ev.allDay ? "All day" : format(new Date(ev.start), "HH:mm")} - ${ev.title} (${ev.calendar})`}
                                  className="tooltip-task text-xs p-1 rounded truncate bg-[#7f6a45]/15 text-[var(--accent)]"
                                >
                                  {ev.title}
                                </div>
                              ))}
                              {dayTasks.slice(0, 2).map((task) => (
                                <div
                                  key={task._id}
                                  data-tooltip={`${task.dueDate ? format(new Date(task.dueDate), "HH:mm") + " - " : ""}${task.title}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openCalendarTaskForEdit(task);
                                  }}
                                  className={cn(
                                    "tooltip-task text-xs p-1 rounded truncate cursor-pointer hover:opacity-80 transition-opacity",
                                    task.quadrant === "urgent-important" && "bg-red-500/20 text-red-400",
                                    task.quadrant === "important-not-urgent" && "bg-yellow-500/20 text-yellow-400",
                                    task.quadrant === "urgent-not-important" && "bg-blue-500/20 text-[var(--accent)]",
                                    task.quadrant === "not-urgent-not-important" && "bg-green-500/20 text-green-400"
                                  )}
                                >
                                  {task.title}
                                </div>
                              ))}
                              {/* Dots indicator for additional tasks/events */}
                              {(dayTasks.length > 2 || dayEvents.length > 1) && (
                                <div className="flex gap-0.5">
                                  {dayEvents.slice(1, 4).map((ev) => (
                                    <div
                                      key={ev.id}
                                      data-tooltip={`${ev.allDay ? "All day" : format(new Date(ev.start), "HH:mm")} - ${ev.title} (${ev.calendar})`}
                                      className="tooltip-task w-1.5 h-1.5 rounded-full bg-[var(--accent)]"
                                    />
                                  ))}
                                  {dayTasks.slice(2, 5).map((task) => (
                                    <div
                                      key={task._id}
                                      data-tooltip={`${task.dueDate ? format(new Date(task.dueDate), "HH:mm") + " - " : ""}${task.title}`}
                                      className={cn(
                                        "tooltip-task w-1.5 h-1.5 rounded-full cursor-pointer",
                                        task.quadrant === "urgent-important" && "bg-red-500",
                                        task.quadrant === "important-not-urgent" && "bg-yellow-500",
                                        task.quadrant === "urgent-not-important" && "bg-blue-500",
                                        task.quadrant === "not-urgent-not-important" && "bg-green-500"
                                      )}
                                    />
                                  ))}
                                  {dayTasks.length > 5 && (
                                    <span className={cn("text-xs", "text-[var(--muted)]")}>
                                      +{dayTasks.length - 5}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Drawer Footer */}
              <div className={cn("p-4 border-t flex gap-3", "border-[var(--drawer-bd)]")}>
                <button
                  onClick={() => setSelectedDate(new Date())}
                  className={cn(
                    "flex-1 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                    "bg-[var(--chip)] hover:brightness-95 text-[var(--ink)]"
                  )}
                >
                  Go to Today
                </button>
                <button
                  onClick={openCalendarTaskForCreate}
                  className="flex-1 px-4 py-2 bg-[var(--btn-primary)] text-[var(--btn-fg)] rounded-lg text-sm font-medium hover:brightness-95 transition-colors flex items-center justify-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add Task
                </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Calendar Task Edit Modal */}
      <Dialog.Root open={isCalendarTaskModalOpen} onOpenChange={setIsCalendarTaskModalOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-[100]" />
          <Dialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[101]",
              "w-[calc(100%-2rem)] max-w-md max-h-[85vh] overflow-y-auto rounded-lg p-4 md:p-6",
              "bg-[var(--drawer)] text-[var(--ink)]"
            )}
          >
            <div className="flex items-center justify-between mb-4 md:mb-6">
              <div className="flex items-center gap-3">
                <Dialog.Title className="text-lg md:text-xl font-semibold">
                  {editingCalendarTask ? "Edit Task" : "New Task"}
                </Dialog.Title>
                {editingCalendarTask && (
                  <>
                    <button
                      onClick={handleMoveToTomorrow}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors",
                        darkMode
                          ? "bg-[#7f6a45]/20 text-[var(--accent)] hover:brightness-110"
                          : "bg-[var(--chip)] text-[var(--accent)] hover:brightness-95"
                      )}
                    >
                      <ArrowRight className="w-3.5 h-3.5" />
                      Tomorrow
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          className={cn(
                            "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors",
                            darkMode
                              ? "bg-green-600/20 text-green-400 hover:bg-green-600/30"
                              : "bg-green-100 text-green-700 hover:bg-green-200"
                          )}
                        >
                          <Share2 className="w-3.5 h-3.5" />
                          Export
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          className={cn(
                            "min-w-[180px] rounded-lg p-1.5 shadow-lg z-[200]",
                            "bg-[var(--drawer)] border border-[var(--drawer-bd)]"
                          )}
                          sideOffset={5}
                        >
                          <DropdownMenu.Item
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer outline-none",
                              "hover:bg-[var(--hover)] text-[var(--ink2)]"
                            )}
                            onClick={() => {
                              const dateObj = calendarTaskForm.date;
                              const [hours, minutes] = calendarTaskForm.time.split(':');
                              const startDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), parseInt(hours ?? "9"), parseInt(minutes ?? "0"));
                              const endDate = new Date(startDate.getTime() + (calendarTaskForm.duration || 30) * 60 * 1000);
                              addToCalendar({ title: calendarTaskForm.title, description: calendarTaskForm.description, startDate, endDate }, 'google');
                              toast.success("Opening Google Calendar");
                            }}
                          >
                            <Calendar className="w-4 h-4 text-red-500" />
                            Google Calendar
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer outline-none",
                              "hover:bg-[var(--hover)] text-[var(--ink2)]"
                            )}
                            onClick={() => {
                              const dateObj = calendarTaskForm.date;
                              const [hours, minutes] = calendarTaskForm.time.split(':');
                              const startDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), parseInt(hours ?? "9"), parseInt(minutes ?? "0"));
                              const endDate = new Date(startDate.getTime() + (calendarTaskForm.duration || 30) * 60 * 1000);
                              addToCalendar({ title: calendarTaskForm.title, description: calendarTaskForm.description, startDate, endDate }, 'outlook');
                              toast.success("Opening Outlook Calendar");
                            }}
                          >
                            <Calendar className="w-4 h-4 text-[var(--accent)]" />
                            Outlook.com
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer outline-none",
                              "hover:bg-[var(--hover)] text-[var(--ink2)]"
                            )}
                            onClick={() => {
                              const dateObj = calendarTaskForm.date;
                              const [hours, minutes] = calendarTaskForm.time.split(':');
                              const startDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), parseInt(hours ?? "9"), parseInt(minutes ?? "0"));
                              const endDate = new Date(startDate.getTime() + (calendarTaskForm.duration || 30) * 60 * 1000);
                              addToCalendar({ title: calendarTaskForm.title, description: calendarTaskForm.description, startDate, endDate }, 'office365');
                              toast.success("Opening Office 365 Calendar");
                            }}
                          >
                            <Calendar className="w-4 h-4 text-blue-600" />
                            Office 365
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer outline-none",
                              "hover:bg-[var(--hover)] text-[var(--ink2)]"
                            )}
                            onClick={() => {
                              const dateObj = calendarTaskForm.date;
                              const [hours, minutes] = calendarTaskForm.time.split(':');
                              const startDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), parseInt(hours ?? "9"), parseInt(minutes ?? "0"));
                              const endDate = new Date(startDate.getTime() + (calendarTaskForm.duration || 30) * 60 * 1000);
                              addToCalendar({ title: calendarTaskForm.title, description: calendarTaskForm.description, startDate, endDate }, 'yahoo');
                              toast.success("Opening Yahoo Calendar");
                            }}
                          >
                            <Calendar className="w-4 h-4 text-purple-500" />
                            Yahoo Calendar
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className={cn("h-px my-1", "bg-[var(--line3)]")} />
                          <DropdownMenu.Item
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 rounded-md text-sm cursor-pointer outline-none",
                              "hover:bg-[var(--hover)] text-[var(--ink2)]"
                            )}
                            onClick={() => {
                              const dateObj = calendarTaskForm.date;
                              const [hours, minutes] = calendarTaskForm.time.split(':');
                              const startDate = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), parseInt(hours ?? "9"), parseInt(minutes ?? "0"));
                              const endDate = new Date(startDate.getTime() + (calendarTaskForm.duration || 30) * 60 * 1000);
                              addToCalendar({ title: calendarTaskForm.title, description: calendarTaskForm.description, startDate, endDate }, 'ics');
                              toast.success("Downloading .ics file");
                            }}
                          >
                            <Download className="w-4 h-4 text-[var(--muted)]" />
                            Download .ics
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </>
                )}
              </div>
              <Dialog.Close asChild>
                <button
                  className={cn(
                    "p-1.5 md:p-2 rounded-lg",
                    "hover:bg-[var(--hover)]"
                  )}
                >
                  <X className="w-4 h-4 md:w-5 md:h-5" />
                </button>
              </Dialog.Close>
            </div>

            <div className="space-y-4">
              {/* Title */}
              <div>
                <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                  Task Title
                </label>
                <input
                  type="text"
                  value={calendarTaskForm.title}
                  onChange={(e) => setCalendarTaskForm(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="Enter task title..."
                  className={cn(
                    "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                    darkMode
                      ? "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                      : "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                  )}
                />
              </div>

              {/* Description */}
              <div>
                <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                  Description
                </label>
                <textarea
                  value={calendarTaskForm.description}
                  onChange={(e) => setCalendarTaskForm(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Add task description..."
                  rows={2}
                  className={cn(
                    "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                    darkMode
                      ? "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                      : "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                  )}
                />
              </div>

              {/* Date and Time Row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                    Date
                  </label>
                  <input
                    type="date"
                    min={format(new Date(), "yyyy-MM-dd")}
                    value={format(calendarTaskForm.date, "yyyy-MM-dd")}
                    onChange={(e) => {
                      // Parse date parts to avoid timezone shift issues
                      const [year, month, day] = e.target.value.split('-').map(Number);
                      const newDate = new Date(year ?? 2025, (month ?? 1) - 1, day ?? 1, 12, 0, 0);
                      // Ignore past dates — scheduling is forward-only
                      if (newDate < startOfDay(new Date())) return;
                      setCalendarTaskForm(prev => ({ ...prev, date: newDate }));
                    }}
                    className={cn(
                      "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                      darkMode
                        ? "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                        : "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                    )}
                  />
                </div>
                <div>
                  <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                    Time
                  </label>
                  <input
                    type="time"
                    value={calendarTaskForm.time}
                    onChange={(e) => setCalendarTaskForm(prev => ({ ...prev, time: e.target.value }))}
                    className={cn(
                      "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                      darkMode
                        ? "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                        : "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                    )}
                  />
                </div>
              </div>

              {/* Duration */}
              <div>
                <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                  Duration (minutes)
                </label>
                <select
                  value={calendarTaskForm.duration}
                  onChange={(e) => setCalendarTaskForm(prev => ({ ...prev, duration: Number(e.target.value) }))}
                  className={cn(
                    "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                    "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                  )}
                >
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={45}>45 minutes</option>
                  <option value={60}>1 hour</option>
                  <option value={90}>1.5 hours</option>
                  <option value={120}>2 hours</option>
                  <option value={180}>3 hours</option>
                </select>
              </div>

              {/* Quadrant */}
              <div>
                <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                  Quadrant
                </label>
                <select
                  value={calendarTaskForm.quadrant}
                  onChange={(e) => setCalendarTaskForm(prev => ({ ...prev, quadrant: e.target.value as TaskQuadrant }))}
                  className={cn(
                    "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                    "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                  )}
                >
                  <option value="urgent-important">Urgent & Important (Do First)</option>
                  <option value="important-not-urgent">Important & Not Urgent (Schedule)</option>
                  <option value="urgent-not-important">Urgent & Not Important (Delegate)</option>
                  <option value="not-urgent-not-important">Not Urgent & Not Important (Eliminate)</option>
                </select>
              </div>

              {/* Priority */}
              <div>
                <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                  Priority
                </label>
                <select
                  value={calendarTaskForm.priority}
                  onChange={(e) => setCalendarTaskForm(prev => ({ ...prev, priority: e.target.value as TaskPriority }))}
                  className={cn(
                    "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                    "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                  )}
                >
                  <option value="high">High Priority</option>
                  <option value="medium">Medium Priority</option>
                  <option value="low">Low Priority</option>
                </select>
              </div>

              {/* Goal */}
              {(goals.length > 0 || calendarTaskForm.goalId) && (
                <div>
                  <label className={cn("block text-sm font-medium mb-2", "text-[var(--ink2)]")}>
                    Goal (optional)
                  </label>
                  <select
                    value={calendarTaskForm.goalId}
                    onChange={(e) => setCalendarTaskForm(prev => ({ ...prev, goalId: e.target.value }))}
                    className={cn(
                      "w-full px-4 py-2 rounded-lg border focus:outline-none focus:ring-2 focus:ring-[var(--pill-active)]",
                      darkMode
                        ? "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                        : "bg-[var(--field)] border-[var(--field-bd)] text-[var(--ink)]"
                    )}
                  >
                    {renderGoalSelectOptions(calendarTaskForm.goalId)}
                  </select>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 mt-6">
              {editingCalendarTask && (
                <button
                  onClick={handleDeleteCalendarTask}
                  className={cn(
                    "px-4 py-2 rounded-lg font-medium transition-colors",
                    "bg-red-500/20 text-red-400 hover:bg-red-500/30"
                  )}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
              <Dialog.Close asChild>
                <button
                  className={cn(
                    "flex-1 px-4 py-2 rounded-lg font-medium transition-colors",
                    "bg-[var(--chip)] hover:brightness-95 text-[var(--ink)]"
                  )}
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                onClick={handleSaveCalendarTask}
                disabled={!calendarTaskForm.title.trim()}
                className="flex-1 px-4 py-2 bg-[var(--btn-primary)] text-[var(--btn-fg)] rounded-lg font-medium hover:brightness-95 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingCalendarTask ? "Update" : "Create"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* ===== Today (routine + schedule) ===== */}
      <div className="mx-auto max-w-[1320px] px-5 md:px-10 mb-[22px]">
        <div className="flex flex-wrap items-baseline gap-3 mt-1 mb-4">
          <span style={{ fontFamily: "var(--font-serif)" }} className="text-[23px] md:text-[26px]">Today</span>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>your routine and what&apos;s on the calendar</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-[22px]">
          {/* Today's routine */}
          <div className="rounded-2xl" style={{ background: "var(--card)", border: "1px solid var(--card-bd)", padding: "22px 24px" }}>
            <div className="flex items-baseline justify-between mb-3">
              <span style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[20px]">Today&apos;s routine</span>
              <button onClick={() => setRoutineDrawerOpen(true)} className="text-[12px]" style={{ color: "var(--accent)" }}>Manage ›</button>
            </div>
            {routineTotal === 0 ? (
              <div className="py-1">
                <div className="text-[14px]" style={{ color: "var(--ink3)" }}>No routine yet.</div>
                <div className="text-[12.5px] mt-1 mb-3" style={{ color: "var(--muted)" }}>Add the small daily things you want to stay on top of.</div>
                <button onClick={() => setRoutineDrawerOpen(true)} className="text-[12.5px] font-semibold" style={{ color: "var(--accent)" }}>+ Build your routine</button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-[22px]">
                  <div className="flex-1 h-[6px] rounded-full overflow-hidden" style={{ background: "var(--line3)" }}>
                    <div className="h-full rounded-full" style={{ width: `${routineTotal ? (routineDone / routineTotal) * 100 : 0}%`, background: "var(--pill-active)" }} />
                  </div>
                  <span className="text-[12px] whitespace-nowrap" style={{ color: "var(--muted)" }}>{routineDone} of {routineTotal} done</span>
                </div>
                {/* Split into two explicit columns so the sequence runs down the
                    first column before continuing in the second, rather than
                    zig-zagging across rows. */}
                {(() => {
                  const rows = [
                    ...todaysChecklistItems.map((item, idx) => {
                      const done = isChecklistItemCompletedToday(item);
                      return (
                        <div key={item._id} className="flex items-center gap-[10px]">
                          <span className="text-[11px] tabular-nums w-[15px] text-right shrink-0" style={{ color: "var(--muted4)" }}>{idx + 1}</span>
                          <span className={cn("qcheck", done && "checked")} onClick={() => void handleToggleChecklistItem(item._id)} />
                          <span className="text-[13.5px]" style={{ color: done ? "var(--strike)" : "var(--ink2)", textDecoration: done ? "line-through" : undefined }}>{item.title}</span>
                          {item.description && renderDescriptionInfo(item.title, item.description)}
                        </div>
                      );
                    }),
                    ...dueMaintenanceItems.map((m) => {
                      const done = isMaintenanceDoneToday(m);
                      const late = !done && maintenanceDaysLate(m) > 0;
                      return (
                        <div key={m._id} className="flex items-center gap-[10px]">
                          <span className="w-[15px] shrink-0" />
                          <span className={cn("qcheck", done && "checked")} onClick={() => { if (!done) void handleMarkMaintenanceDone(m._id); }} />
                          <span className="text-[13.5px]" style={{ color: done ? "var(--strike)" : "var(--ink2)", textDecoration: done ? "line-through" : undefined }}>{m.title}</span>
                          {m.description && renderDescriptionInfo(m.title, m.description)}
                          {!done && (
                            late ? (
                              <span className="text-[10px] px-[7px] py-px rounded-[5px] shrink-0" style={{ color: "var(--tag-fg)", background: "var(--tag-bg)" }}>
                                Late{maintenanceDaysLate(m) > 1 ? ` ${maintenanceDaysLate(m)}d` : ""}
                              </span>
                            ) : (
                              <span className="text-[10px] px-[7px] py-px rounded-[5px] shrink-0" style={{ color: "var(--muted5)", background: "var(--chip)" }}>Due</span>
                            )
                          )}
                        </div>
                      );
                    }),
                  ];
                  const half = Math.ceil(rows.length / 2);
                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-[18px]">
                      <div className="flex flex-col gap-[18px]">{rows.slice(0, half)}</div>
                      {rows.length > half && (
                        <div className="flex flex-col gap-[18px]">{rows.slice(half)}</div>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
          {/* Today's schedule */}
          <div className="rounded-2xl overflow-hidden" style={{ background: "var(--card)", border: "1px solid var(--card-bd)" }}>
            <div style={{ padding: "22px 24px" }}>
              <div className="flex items-baseline justify-between mb-3">
                <span style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[17px]">Today&apos;s schedule</span>
                <button onClick={() => setIsCalendarDrawerOpen(true)} className="text-[12px]" style={{ color: "var(--accent)" }}>Open ›</button>
              </div>
              {todaysScheduleItems.length === 0 ? (
                <div className="pt-1">
                  <div className="text-[13.5px]" style={{ color: "var(--ink3)" }}>Nothing scheduled today.</div>
                  <div className="text-[12px] mt-1" style={{ color: "var(--muted)" }}>Add a task with a time, or connect a calendar in settings.</div>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {todaysScheduleItems.map((item) => {
                    if (item.kind === "task") {
                      const t = item.task;
                      const doFirst = t.quadrant === "urgent-important";
                      return (
                        <div key={`task-${t._id}`} className="flex gap-3 cursor-pointer" onClick={() => void openTaskForEdit(t)}>
                          <span className="text-[11px] w-[52px] text-right pt-0.5 shrink-0" style={{ color: "var(--muted2)" }}>{t.dueDate ? format(new Date(t.dueDate), "h:mm") : ""}</span>
                          <div className="flex-1 pb-3 pl-[14px] ml-0.5" style={{ borderLeft: `2px solid ${doFirst ? "var(--q-do-first)" : "var(--form-bd)"}` }}>
                            <div className="flex items-center gap-2">
                              <span className="text-[13.5px]" style={{ color: "var(--ink)" }}>{t.title}</span>
                              {doFirst && <span className="text-[10px] px-[7px] py-px rounded-[5px]" style={{ color: "var(--tag-fg)", background: "var(--tag-bg)" }}>Do First</span>}
                            </div>
                            <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                              {t.dueDate ? format(new Date(t.dueDate), "h:mm a") : ""}{t.duration ? ` · ${t.duration} min` : ""}
                            </div>
                          </div>
                        </div>
                      );
                    }
                    const ev = item.event;
                    return (
                      <div key={`event-${ev.id}`} className="flex gap-3">
                        <span className="text-[11px] w-[52px] text-right pt-0.5 shrink-0" style={{ color: "var(--muted2)" }}>
                          {ev.allDay ? "all day" : format(new Date(ev.start), "h:mm")}
                        </span>
                        <div className="flex-1 pb-3 pl-[14px] ml-0.5" style={{ borderLeft: "2px solid var(--form-bd)" }}>
                          <div className="text-[13.5px]" style={{ color: "var(--ink2)" }}>{ev.title}</div>
                          <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                            {ev.allDay ? ev.calendar : `${format(new Date(ev.start), "h:mm a")} · ${ev.calendar}`}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {calendarFeedError && (
                    <div className="flex items-center gap-1.5 pt-1 text-[11.5px]" style={{ color: "var(--muted)" }}>
                      <AlertCircle className="w-3 h-3" />
                      A calendar feed couldn&apos;t be loaded — check its URL in settings.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {/* Payments load failure — otherwise invisible */}
      {paymentsError && (
        <div className="mx-auto max-w-[1320px] px-5 md:px-10 mb-1">
          <div className="flex items-center gap-2 px-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            <AlertCircle className="w-3.5 h-3.5" />
            Couldn&apos;t load payments
            <button onClick={() => void fetchPaymentsDue(paymentsDate)} className="font-semibold" style={{ color: "var(--accent)" }}>Retry</button>
          </div>
        </div>
      )}

      {/* ===== Payments due bar ===== */}
      {paymentsSummary && (
        <div className="mx-auto max-w-[1320px] px-5 md:px-10 mb-1">
          {paymentsSummary.hasDue ? (
            <div onClick={() => setPaymentsDrawerOpen(true)}
              className="flex flex-wrap items-center justify-between gap-x-[22px] gap-y-[14px] rounded-[14px] px-[22px] py-[15px] cursor-pointer"
              style={{ background: "var(--card)", border: "1px solid var(--card-bd)" }}>
              <div className="flex items-center gap-[13px]">
                <span className="text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--muted2)" }}>Payments due</span>
                {renderPaymentsDateNav()}
                <span className="w-[13px] h-[13px] rounded-full shrink-0" style={{ border: "1.5px solid var(--accent)" }} />
                <span className="text-[15px] font-semibold" style={{ color: "var(--ink)" }}>{fmtMoney(paymentsSummary.totalDue)}</span>
                <span className="text-[12px]" style={{ color: "var(--muted)" }}>· {paymentsSummary.count} payment{paymentsSummary.count === 1 ? "" : "s"}</span>
              </div>
              <div className="flex items-center gap-5 text-[12.5px]" style={{ color: "var(--muted)" }}>
                <span>Income <span style={{ color: "var(--ink3)" }}>{fmtMoney(paymentsSummary.income)}</span></span>
                <span>Day ends <span className="font-semibold" style={{ color: paymentsSummary.dayEnds >= 0 ? "#16a34a" : "var(--tag-fg)" }}>
                  {paymentsSummary.dayEnds >= 0 ? "+" : "−"}{fmtMoney(paymentsSummary.dayEnds)}
                </span></span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-[10px] px-1 pt-1.5 pb-0.5 text-[12.5px]" style={{ color: "var(--muted)" }}>
              <span className="w-[15px] h-[15px] rounded-full flex items-center justify-center text-[9px]" style={{ border: "1.5px solid var(--accent)", color: "var(--accent)" }}>✓</span>
              {renderPaymentsDateNav()}
              Nothing due{paymentsDateIsToday ? " today" : ""} — day ends <span className="font-semibold" style={{ color: "var(--ink3)" }}>+{fmtMoney(paymentsSummary.income)}</span>
            </div>
          )}
        </div>
      )}

      {/* ===== Priority Matrix (hero) ===== */}
      <div className="mx-auto max-w-[1320px] px-5 md:px-10 pb-16">
        <div className="flex flex-wrap items-baseline gap-3 mt-2 mb-[18px]">
          <span style={{ fontFamily: "var(--font-serif)" }} className="text-[23px] md:text-[26px]">Priority Matrix</span>
          <span className="text-[13px]" style={{ color: "var(--muted)" }}>four quadrants, one clear next move each</span>
        </div>
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[22px]">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-2xl min-h-[300px]"
                style={{ background: "var(--surface)", border: "1px solid var(--surface-bd)", boxShadow: "0 14px 34px -20px rgba(70,55,30,0.45)", padding: "18px 22px" }}>
                <div className="skel" style={{ width: 110, height: 20, marginBottom: 22 }} />
                <div className="skel" style={{ width: "100%", height: 46, marginBottom: 18 }} />
                <div className="skel" style={{ width: "80%", height: 14, marginBottom: 11 }} />
                <div className="skel" style={{ width: "70%", height: 14, marginBottom: 11 }} />
                <div className="skel" style={{ width: "60%", height: 14 }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[22px]">
            {MATRIX_ORDER.map((quadrant) => {
              const meta = MATRIX_META[quadrant];
              const { nextAction, upNext, cleared } = getQuadrantView(quadrant);
              const quickVal = quickTaskInputs[quadrant];
              return (
                <div key={quadrant} className="rounded-2xl overflow-hidden flex flex-col min-h-[300px]"
                  style={{ background: "var(--surface)", border: "1px solid var(--surface-bd)", boxShadow: "0 14px 34px -20px rgba(70,55,30,0.45)" }}>
                  {/* quadrant header */}
                  <div className="flex items-start justify-between px-[22px] py-[15px]" style={{ borderBottom: "1px solid var(--line2)" }}>
                    <div>
                      <div className="flex items-center gap-[9px]">
                        <span className="w-[9px] h-[9px] rounded-full shrink-0" style={{ background: meta.color }} />
                        <span style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px] leading-tight">{meta.name}</span>
                      </div>
                      <div className="text-[11px] tracking-[0.12em] uppercase mt-[3px] ml-[18px]" style={{ color: "var(--muted3)" }}>{meta.subtitle}</div>
                    </div>
                    <span style={{ fontFamily: "var(--font-serif)", color: "var(--num)" }} className="text-[15px]">{meta.index}</span>
                  </div>
                  {/* quadrant body */}
                  <div className="px-[22px] pt-5 pb-[22px] flex-1 flex flex-col">
                    {(nextAction ?? cleared) ? (
                      <>
                        {!nextAction ? (
                          <div style={{ borderLeft: "2px solid var(--line)", paddingLeft: 14 }}>
                            <span className="text-[11px] tracking-[0.1em] uppercase" style={{ color: "var(--muted3)" }}>{meta.nextLabel}</span>
                            <div className="text-[14px] mt-[3px]" style={{ color: "var(--muted3)" }}>
                              None chosen — promote one from Up next.
                            </div>
                          </div>
                        ) : (
                        <div style={{ borderLeft: `2px solid ${meta.color}`, paddingLeft: 14 }}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] tracking-[0.1em] uppercase" style={{ color: "var(--muted3)" }}>{meta.nextLabel}</span>
                            <button onClick={() => handleDemoteNextAction(quadrant)} title="Demote — leave no next action"
                              className="shrink-0 p-0.5 rounded outline-none opacity-40 hover:opacity-100 transition-opacity" style={{ color: "var(--muted4)" }}>
                              <ChevronDown className="w-[14px] h-[14px]" />
                            </button>
                          </div>
                          <div className="flex items-start gap-[11px] mt-[3px]">
                            <span className={cn("qcheck", nextAction.status === "completed" && "checked")}
                              style={{ marginTop: 5, opacity: nextAction.status !== "completed" && checklistGate(nextAction) ? 0.5 : undefined }}
                              title={checklistGate(nextAction) ? `${checklistGate(nextAction)!.remaining} required step${checklistGate(nextAction)!.remaining === 1 ? "" : "s"} left on ${checklistGate(nextAction)!.name}` : undefined}
                              onClick={() => void handleToggleComplete(nextAction)} />
                            <div className="text-[17px] font-semibold cursor-pointer" onClick={() => void openTaskForEdit(nextAction)} style={{ color: "var(--ink)", textDecoration: nextAction.status === "completed" ? "line-through" : undefined }}>
                              {nextAction.title}
                              {goalIconOf(nextAction.goalId ? goalsById.get(nextAction.goalId) : undefined) && (
                                <span className="inline-block align-middle ml-1.5 text-[14px] leading-none"
                                  title={`Goal: ${goalsById.get(nextAction.goalId!)?.title ?? ""}`}>
                                  {goalIconOf(goalsById.get(nextAction.goalId!))}
                                </span>
                              )}
                              {nextAction.linkedParentId && (
                                <span className="inline-flex items-center align-middle ml-1.5" title={`Part of: ${linkedParentTitle(nextAction) ?? "another task"}`} style={{ color: "var(--muted3)" }}>
                                  <Link2 className="w-[14px] h-[14px]" />
                                </span>
                              )}
                              {nextAction.dueDate && nextAction.status !== "completed" && (
                                isTaskOverdue(nextAction) ? (
                                  <span className="text-[12px] font-normal" style={{ color: "var(--tag-fg)" }}> · overdue {format(new Date(nextAction.dueDate), "MMM d")}</span>
                                ) : (
                                  <span className="text-[12px] font-normal" style={{ color: "var(--muted3)" }}> · {format(new Date(nextAction.dueDate), "MMM d")}</span>
                                )
                              )}
                              {formatShortDuration(nextAction.duration) && nextAction.status !== "completed" && (
                                <span className="text-[12px] font-normal" style={{ color: "var(--muted4)" }}> · {formatShortDuration(nextAction.duration)}</span>
                              )}
                              {gateHintTaskId === nextAction._id && checklistGate(nextAction) && (
                                <span className="text-[12px] font-normal" style={{ color: "var(--tag-fg)" }}>
                                  {" "}· {checklistGate(nextAction)!.remaining} required step{checklistGate(nextAction)!.remaining === 1 ? "" : "s"} left on {checklistGate(nextAction)!.name}
                                </span>
                              )}
                            </div>
                            {quadrant === SCHEDULE_QUADRANT && !nextAction.dueDate && nextAction.status !== "completed" && (
                              <span className="mt-[5px]">{renderScheduleButton(nextAction, "md")}</span>
                            )}
                          </div>
                          {/* Presence only - no fraction, no bar. The hero names the next move;
                              a count here invites auditing instead of doing. */}
                          {(nextAction.checklists ?? []).length > 0 && (
                            <div className="flex items-center gap-1.5 mt-2 text-[11px] cursor-pointer"
                              style={{ color: "var(--muted3)" }}
                              onClick={() => void openTaskForEdit(nextAction)}>
                              <ListChecks className="w-[11px] h-[11px] shrink-0" />
                              <span className="truncate">
                                {[...(nextAction.checklists ?? [])].sort((a, b) => a.order - b.order)[0]!.name}
                                {(nextAction.checklists ?? []).length > 1 && ` +${(nextAction.checklists ?? []).length - 1}`}
                              </span>
                            </div>
                          )}
                        </div>
                        )}
                        {upNext.length > 0 && (
                          <div className="mt-4 pt-[15px]" style={{ borderTop: "1px solid var(--line2)" }}>
                            <div className="text-[10px] tracking-[0.12em] uppercase mb-3" style={{ color: "var(--muted4)" }}>Up next</div>
                            <DndContext id={`tasks-${quadrant}`} sensors={taskSensors} collisionDetection={closestCenter}
                              modifiers={[lockToVerticalAxis]} onDragEnd={handleTaskDragEnd}>
                            <SortableContext items={upNext.map(t => t._id)} strategy={verticalListSortingStrategy}>
                            <div className="flex flex-col gap-[11px]">
                              {upNext.map((t, i) => {
                                // Rows are grouped scheduled → unscheduled → completed.
                                // Mark each boundary once, the first time it's crossed.
                                const prev = i === 0 ? nextAction : upNext[i - 1];
                                const done = t.status === "completed";
                                const prevDone = prev?.status === "completed";
                                const showCompletedDivider = done && !prevDone;
                                const showUnscheduledDivider = !done && !t.dueDate && !!prev?.dueDate;
                                // Dated tasks follow their due date and done ones sink, so
                                // only unscheduled open tasks can be dragged.
                                const draggable = !done && !t.dueDate;
                                return (
                                <Fragment key={t._id}>
                                {showUnscheduledDivider && (
                                  <div className="flex items-center gap-2 pt-[7px] pb-[1px]">
                                    <span className="text-[10px] tracking-[0.12em] uppercase shrink-0" style={{ color: "var(--muted4)" }}>Unscheduled</span>
                                    <span className="flex-1 h-px" style={{ background: "var(--line2)" }} />
                                  </div>
                                )}
                                {showCompletedDivider && (
                                  <div className="flex items-center gap-2 pt-[7px] pb-[1px]">
                                    <span className="text-[10px] tracking-[0.12em] uppercase shrink-0" style={{ color: "var(--muted4)" }}>Completed</span>
                                    <span className="flex-1 h-px" style={{ background: "var(--line2)" }} />
                                  </div>
                                )}
                                <SortableTaskRow id={t._id} disabled={!draggable}>
                                {(handle) => (<>
                                  <span className={cn("qcheck", t.status === "completed" && "checked")}
                                    style={{ opacity: t.status !== "completed" && checklistGate(t) ? 0.5 : undefined }}
                                    title={checklistGate(t) ? `${checklistGate(t)!.remaining} required step${checklistGate(t)!.remaining === 1 ? "" : "s"} left on ${checklistGate(t)!.name}` : undefined}
                                    onClick={() => void handleToggleComplete(t)} />
                                  <span className="text-[14px] cursor-pointer flex-1 min-w-0 truncate" onClick={() => void openTaskForEdit(t)}
                                    style={{ color: t.status === "completed" ? "var(--strike)" : "var(--ink3)", textDecoration: t.status === "completed" ? "line-through" : undefined }}>
                                    {t.title}
                                  </span>
                                  {gateHintTaskId === t._id && checklistGate(t) && (
                                    <span onClick={() => { setExpandedTaskChecklistIds(new Set([checklistGate(t)!.checklistId])); void openTaskForEdit(t); }}
                                      className="shrink-0 text-[10px] px-[7px] py-px rounded-[5px] cursor-pointer"
                                      style={{ color: "var(--tag-fg)", background: "var(--tag-bg)" }}>
                                      {checklistGate(t)!.remaining} required left on {checklistGate(t)!.name}
                                    </span>
                                  )}
                                  {goalIconOf(t.goalId ? goalsById.get(t.goalId) : undefined) && (
                                    <span className="shrink-0 text-[13px] leading-none"
                                      title={`Goal: ${goalsById.get(t.goalId!)?.title ?? ""}`}>
                                      {goalIconOf(goalsById.get(t.goalId!))}
                                    </span>
                                  )}
                                  {t.linkedParentId && (
                                    <span className="shrink-0 inline-flex items-center" title={`Part of: ${linkedParentTitle(t) ?? "another task"}`} style={{ color: "var(--muted3)" }}>
                                      <Link2 className="w-[13px] h-[13px]" />
                                    </span>
                                  )}
                                  {t.dueDate && t.status !== "completed" && (
                                    <span className="text-[12px] font-normal shrink-0 tabular-nums"
                                      style={{ color: isTaskOverdue(t) ? "var(--tag-fg)" : "var(--muted3)" }}>
                                      {format(new Date(t.dueDate), "MMM d")}
                                    </span>
                                  )}
                                  {t.status === "completed" && t.completedAt && (
                                    <span className="text-[12px] font-normal shrink-0 tabular-nums"
                                      title={`Completed ${format(new Date(t.completedAt), "PPpp")}`}
                                      style={{ color: "var(--muted4)" }}>
                                      Done {format(new Date(t.completedAt), "MMM d")}
                                    </span>
                                  )}
                                  {quadrant === SCHEDULE_QUADRANT && !t.dueDate && t.status !== "completed" && renderScheduleButton(t)}
                                  {formatShortDuration(t.duration) && t.status !== "completed" && (
                                    <span className="text-[12px] font-normal shrink-0 inline-flex items-center gap-[3px] tabular-nums" style={{ color: "var(--muted4)" }}>
                                      <Clock className="w-[11px] h-[11px]" />{formatShortDuration(t.duration)}
                                    </span>
                                  )}
                                  <DropdownMenu.Root open={rowMenuTaskId === t._id} onOpenChange={(open) => setRowMenuTaskId(open ? t._id : null)}>
                                    {/* The grip drags the row on press-and-move and opens the menu
                                        on click: the default-prevented pointerdown keeps Radix from
                                        opening it on press (dnd-kit's listener runs first), and
                                        dnd-kit swallows the click that ends a drag. */}
                                    <DropdownMenu.Trigger asChild onPointerDown={(e) => e.preventDefault()} onClick={() => setRowMenuTaskId(t._id)}>
                                      <button ref={handle.setActivatorNodeRef} {...handle.listeners}
                                        className={cn("shrink-0 p-0.5 rounded outline-none opacity-40 hover:opacity-100 transition-opacity",
                                          draggable && "cursor-grab active:cursor-grabbing touch-none",
                                          handle.isDragging && "opacity-100")}
                                        title={draggable ? "Drag to reorder · click for options" : "Options"} style={{ color: "var(--muted4)" }}>
                                        <GripVertical className="w-[14px] h-[14px]" />
                                      </button>
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Portal>
                                      <DropdownMenu.Content align="end" sideOffset={5}
                                        className="min-w-[168px] rounded-lg p-1.5 shadow-lg z-[200] bg-[var(--drawer)] border border-[var(--drawer-bd)]">
                                        <DropdownMenu.Item onSelect={() => handleMakeNextAction(t)}
                                          className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer outline-none hover:bg-[var(--hover)] text-[var(--ink2)]">
                                          <ChevronsUp className="w-4 h-4" style={{ color: "var(--accent)" }} /> Make next action
                                        </DropdownMenu.Item>
                                        {/* Dated tasks follow their due date, so manual nudging applies to unscheduled ones only. */}
                                        {!t.dueDate ? (
                                          <>
                                            <DropdownMenu.Item onSelect={() => void handleReorderTask(t, "up")}
                                              className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer outline-none hover:bg-[var(--hover)] text-[var(--ink2)]">
                                              <ChevronUp className="w-4 h-4" style={{ color: "var(--muted2)" }} /> Move up
                                            </DropdownMenu.Item>
                                            <DropdownMenu.Item disabled={i === upNext.length - 1} onSelect={() => void handleReorderTask(t, "down")}
                                              className={cn("flex items-center gap-2 px-3 py-2 rounded-md text-[13px] outline-none", i === upNext.length - 1 ? "opacity-40" : "cursor-pointer hover:bg-[var(--hover)]")}
                                              style={{ color: "var(--ink2)" }}>
                                              <ChevronDown className="w-4 h-4" style={{ color: "var(--muted2)" }} /> Move down
                                            </DropdownMenu.Item>
                                          </>
                                        ) : (
                                          <div className="px-3 py-2 text-[12px]" style={{ color: "var(--muted3)" }}>Ordered by due date</div>
                                        )}
                                        <DropdownMenu.Separator className="h-px my-1 bg-[var(--line3)]" />
                                        <DropdownMenu.Item onSelect={() => void handleArchiveTask(t)}
                                          className="flex items-center gap-2 px-3 py-2 rounded-md text-[13px] cursor-pointer outline-none hover:bg-[var(--hover)] text-[var(--ink2)]">
                                          <Archive className="w-4 h-4" style={{ color: "var(--muted2)" }} /> Archive
                                        </DropdownMenu.Item>
                                      </DropdownMenu.Content>
                                    </DropdownMenu.Portal>
                                  </DropdownMenu.Root>
                                </>)}
                                </SortableTaskRow>
                                </Fragment>
                                );
                              })}
                            </div>
                            </SortableContext>
                            </DndContext>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="pt-[18px] pb-2">
                        <div className="text-[15px]" style={{ color: "var(--ink3)" }}>{meta.emptyTitle}</div>
                        <div className="text-[12.5px] mt-1" style={{ color: "var(--muted)" }}>{meta.emptySub}</div>
                      </div>
                    )}
                    {/* quick add */}
                    <div className="mt-auto pt-[18px]">
                      <div className="hovrow flex items-center gap-[9px] px-3 py-[9px] rounded-[10px]"
                        style={{ border: "1px dashed var(--dash)" }}>
                        <span className="text-[15px] leading-none" style={{ color: "var(--muted3)" }}>+</span>
                        <input
                          type="text"
                          value={quickVal}
                          placeholder={meta.addLabel}
                          onChange={(e) => setQuickTaskInputs(prev => ({ ...prev, [quadrant]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && quickVal.trim()) void handleQuickAddTask(quadrant, quickVal);
                          }}
                          className="bg-transparent outline-none text-[13px] w-full placeholder:text-[color:var(--muted3)]"
                          style={{ color: "var(--ink)" }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ===== Calm Editorial drawers ===== */}
      {(routineDrawerOpen || isGoalsExpanded || paymentsDrawerOpen || myndlistDrawerOpen) && (
        <div
          onClick={() => { setRoutineDrawerOpen(false); setIsGoalsExpanded(false); setPaymentsDrawerOpen(false); resetGoalForm(); closeChecklistLibrary(); }}
          className="fixed inset-0 z-[60]"
          style={{ background: "var(--overlay)", animation: "fadeIn .2s ease" }}
        />
      )}

      {/* Routine drawer */}
      {routineDrawerOpen && (
        <div className="fixed top-0 right-0 bottom-0 z-[61] w-[460px] max-w-[94vw] overflow-y-auto"
          style={{ background: "var(--drawer)", borderLeft: "1px solid var(--drawer-bd)", boxShadow: "-24px 0 60px -30px rgba(70,55,30,0.4)", animation: "drawerIn .28s cubic-bezier(.16,1,.3,1)" }}>
          <div className="flex items-start justify-between" style={{ padding: "24px 26px 0" }}>
            <div>
              <div style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px]">Routines &amp; Maintenance</div>
              <div className="text-[13px] mt-0.5" style={{ color: "var(--muted)" }}>Recurring items that reset on their own schedule.</div>
            </div>
            <button onClick={() => { setRoutineDrawerOpen(false); resetChecklistForm(); resetMaintenanceForm(); }} className="p-1 text-[20px]" style={{ color: "var(--muted)" }}>✕</button>
          </div>
          <div className="flex gap-1.5" style={{ padding: "18px 26px 0" }}>
            {(["today", "all", "maintenance"] as const).map((tab) => (
              <button key={tab} onClick={() => setChecklistTab(tab)}
                className="text-[13px] rounded-[9px] capitalize"
                style={{ padding: "7px 15px", fontWeight: checklistTab === tab ? 600 : 400, color: checklistTab === tab ? "var(--btn-fg)" : "var(--accent)", background: checklistTab === tab ? "var(--pill-active)" : "var(--chip)" }}>
                {tab}
              </button>
            ))}
          </div>

          {checklistTab !== "maintenance" && (
            <div style={{ padding: "14px 20px 4px" }} className="flex flex-col">
              {(checklistTab === "all" ? checklistItems : todaysChecklistItems).length === 0 && (
                <div className="text-[13.5px] px-2 py-3" style={{ color: "var(--muted)" }}>No routine items yet.</div>
              )}
              {(() => {
                const visible = checklistTab === "all" ? checklistItems : todaysChecklistItems;
                return visible.map((item, idx) => {
                const done = isChecklistItemCompletedToday(item);
                const badge = item.frequency === "daily" ? "daily" : (item.daysOfWeek?.length ? item.daysOfWeek.map((d) => DAY_LABELS[d]).join(", ") : "weekly");
                return (
                  <div key={item._id} className="flex items-center gap-[10px] rounded-[10px]" style={{ padding: "10px 8px" }}>
                    <span className="text-[11px] tabular-nums w-[16px] text-right shrink-0" style={{ color: "var(--muted4)" }}>{idx + 1}</span>
                    <span className={cn("qcheck", done && "checked")} onClick={() => void handleToggleChecklistItem(item._id)} />
                    <span className="flex-1 text-[14px]" style={{ color: done ? "var(--strike)" : "var(--ink2)", textDecoration: done ? "line-through" : undefined }}>{item.title}</span>
                    <span className="text-[11px] rounded-[6px]" style={{ padding: "2px 9px", color: "var(--muted)", background: "var(--chip)" }}>{badge}</span>
                    <div className="flex flex-col shrink-0">
                      <button onClick={() => void handleReorderChecklistItem(item, "up", visible)} disabled={idx === 0}
                        title="Move up" className={cn("p-0 leading-none", idx === 0 ? "opacity-25" : "opacity-60 hover:opacity-100")} style={{ color: "var(--muted2)" }}>
                        <ChevronUp className="w-[14px] h-[14px]" />
                      </button>
                      <button onClick={() => void handleReorderChecklistItem(item, "down", visible)} disabled={idx === visible.length - 1}
                        title="Move down" className={cn("p-0 leading-none", idx === visible.length - 1 ? "opacity-25" : "opacity-60 hover:opacity-100")} style={{ color: "var(--muted2)" }}>
                        <ChevronDown className="w-[14px] h-[14px]" />
                      </button>
                    </div>
                    <button onClick={() => openChecklistItemForEdit(item)} style={{ color: "var(--muted2)" }} className="text-[13px] p-0.5"><Edit3 className="w-[15px] h-[15px]" /></button>
                    <button onClick={() => void handleDeleteChecklistItem(item._id)} style={{ color: "var(--tag-fg)" }} className="p-0.5"><Trash2 className="w-[15px] h-[15px]" /></button>
                  </div>
                );
                });
              })()}
              {showChecklistForm ? (
                <div className="rounded-[14px] mt-2" style={{ margin: "8px 2px 20px", padding: "18px", background: "var(--form-bg)", border: "1px solid var(--form-bd)" }}>
                  <div style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[16px] mb-3">{editingChecklistItem ? "Edit routine item" : "New routine item"}</div>
                  <input type="text" autoFocus placeholder="e.g. Drink water" value={checklistFormData.title}
                    onChange={(e) => setChecklistFormData((p) => ({ ...p, title: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === "Enter" && checklistFormData.title.trim()) void (editingChecklistItem ? handleUpdateChecklistItem() : handleAddChecklistItem()); }}
                    className="w-full text-[13.5px] rounded-[10px] outline-none mb-3" style={{ padding: "11px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                  <div className="flex gap-2 mb-3">
                    {(["daily", "weekly"] as const).map((f) => (
                      <button key={f} onClick={() => setChecklistFormData((p) => ({ ...p, frequency: f, daysOfWeek: f === "daily" ? [] : p.daysOfWeek }))}
                        className="text-[12.5px] rounded-[9px] capitalize" style={{ padding: "7px 16px", fontWeight: checklistFormData.frequency === f ? 600 : 400, color: checklistFormData.frequency === f ? "var(--btn-fg)" : "var(--accent)", background: checklistFormData.frequency === f ? "var(--pill-active)" : "var(--chip)" }}>{f}</button>
                    ))}
                  </div>
                  <textarea placeholder="Description · optional — shown from the routine card" value={checklistFormData.description} rows={2}
                    onChange={(e) => setChecklistFormData((p) => ({ ...p, description: e.target.value }))}
                    className="w-full text-[13.5px] rounded-[10px] outline-none mb-3 resize-y" style={{ padding: "11px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                  {checklistFormData.frequency === "weekly" && (
                    <div className="flex gap-1.5 mb-3">
                      {DAY_LABELS.map((label, i) => (
                        <button key={label} onClick={() => setChecklistFormData((p) => ({ ...p, daysOfWeek: p.daysOfWeek.includes(i) ? p.daysOfWeek.filter((d) => d !== i) : [...p.daysOfWeek, i] }))}
                          className="w-[30px] h-[30px] rounded-[8px] text-[12px] flex items-center justify-center"
                          style={{ border: "1px solid var(--field-bd)", color: checklistFormData.daysOfWeek.includes(i) ? "var(--btn-fg)" : "var(--muted5)", background: checklistFormData.daysOfWeek.includes(i) ? "var(--pill-active)" : "transparent" }}>{label.charAt(0)}</button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2.5 mt-1">
                    <button onClick={editingChecklistItem ? handleUpdateChecklistItem : handleAddChecklistItem} disabled={!checklistFormData.title.trim() || checklistLoading}
                      className="cta text-[13px] font-semibold rounded-[10px] disabled:opacity-50" style={{ padding: "9px 20px", color: "var(--btn-fg)", background: "var(--btn-primary)" }}>{checklistLoading ? "Saving…" : editingChecklistItem ? "Update" : "Add item"}</button>
                    <button onClick={resetChecklistForm} className="text-[13px]" style={{ padding: "9px 16px", color: "var(--accent)" }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowChecklistForm(true)} className="hovrow text-[13px] text-center rounded-[11px] mt-2" style={{ margin: "8px 2px 20px", padding: "11px", border: "1px dashed var(--check-bd)", color: "var(--muted5)" }}>+ Add a routine item</button>
              )}
            </div>
          )}

          {checklistTab === "maintenance" && (
            <div style={{ padding: "14px 20px 20px" }} className="flex flex-col gap-2">
              {maintenanceItems.length === 0 && <div className="text-[13.5px] px-2 py-2" style={{ color: "var(--muted)" }}>No maintenance items yet.</div>}
              {maintenanceItems.map((m) => (
                <div key={m._id} className="flex items-center gap-3 rounded-[11px]" style={{ padding: "12px 14px", background: "var(--field)", border: "1px solid var(--field-bd)" }}>
                  <div className="flex-1">
                    <div className="text-[14px]" style={{ color: "var(--ink)" }}>{m.title}</div>
                    <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>every {m.intervalDays} days · due {format(new Date(m.nextDueDate), "MMM d")}</div>
                  </div>
                  <button onClick={() => void handleMarkMaintenanceDone(m._id)} className="text-[12px] font-semibold" style={{ color: "var(--accent)" }}>Mark done</button>
                  <button onClick={() => {
                    setEditingMaintenanceItem(m);
                    setMaintenanceFormData({ title: m.title, description: m.description ?? "", intervalDays: m.intervalDays, nextDueDate: m.nextDueDate });
                    setShowMaintenanceForm(true);
                  }} style={{ color: "var(--muted2)" }} className="p-0.5"><Edit3 className="w-[15px] h-[15px]" /></button>
                  <button onClick={() => void handleDeleteMaintenanceItem(m._id)} style={{ color: "var(--tag-fg)" }} className="p-0.5"><Trash2 className="w-[15px] h-[15px]" /></button>
                </div>
              ))}
              {showMaintenanceForm ? (
                <div className="rounded-[14px]" style={{ padding: "16px", background: "var(--form-bg)", border: "1px solid var(--form-bd)" }}>
                  <input type="text" autoFocus placeholder="e.g. Replace furnace filter" value={maintenanceFormData.title}
                    onChange={(e) => setMaintenanceFormData((p) => ({ ...p, title: e.target.value }))}
                    className="w-full text-[13.5px] rounded-[10px] outline-none mb-2.5" style={{ padding: "11px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                  <textarea placeholder="Description · optional — shown from the routine card" value={maintenanceFormData.description} rows={2}
                    onChange={(e) => setMaintenanceFormData((p) => ({ ...p, description: e.target.value }))}
                    className="w-full text-[13.5px] rounded-[10px] outline-none mb-2.5 resize-y" style={{ padding: "11px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {INTERVAL_PRESETS.map((p) => (
                      <button key={p.label} onClick={() => setMaintenanceFormData((f) => ({ ...f, intervalDays: p.days }))}
                        className="text-[12px] rounded-[8px]" style={{ padding: "6px 12px", color: maintenanceFormData.intervalDays === p.days ? "var(--btn-fg)" : "var(--accent)", background: maintenanceFormData.intervalDays === p.days ? "var(--pill-active)" : "var(--chip)" }}>{p.label}</button>
                    ))}
                  </div>
                  <input type="date" value={maintenanceFormData.nextDueDate} onChange={(e) => setMaintenanceFormData((p) => ({ ...p, nextDueDate: e.target.value }))}
                    className="w-full text-[13.5px] rounded-[10px] outline-none mb-3" style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                  <div className="flex gap-2.5">
                    <button onClick={editingMaintenanceItem ? handleUpdateMaintenanceItem : handleAddMaintenanceItem} disabled={!maintenanceFormData.title.trim()}
                      className="cta text-[13px] font-semibold rounded-[10px] disabled:opacity-50" style={{ padding: "9px 20px", color: "var(--btn-fg)", background: "var(--btn-primary)" }}>{editingMaintenanceItem ? "Update" : "Add"}</button>
                    <button onClick={resetMaintenanceForm} className="text-[13px]" style={{ padding: "9px 16px", color: "var(--accent)" }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowMaintenanceForm(true)} className="hovrow text-[13px] text-center rounded-[11px]" style={{ padding: "11px", border: "1px dashed var(--check-bd)", color: "var(--muted5)" }}>+ Add a maintenance item</button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Goals drawer */}
      {isGoalsExpanded && (
        <div className="fixed top-0 right-0 bottom-0 z-[61] w-[460px] max-w-[94vw] overflow-y-auto"
          style={{ background: "var(--drawer)", borderLeft: "1px solid var(--drawer-bd)", boxShadow: "-24px 0 60px -30px rgba(70,55,30,0.4)", animation: "drawerIn .28s cubic-bezier(.16,1,.3,1)" }}>
          <div className="flex items-start justify-between" style={{ padding: "24px 26px 0" }}>
            <div>
              <div style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px]">Goals</div>
              <div className="text-[13px] mt-0.5" style={{ color: "var(--muted)" }}>What you want to focus on and achieve.</div>
            </div>
            <button onClick={() => { setIsGoalsExpanded(false); resetGoalForm(); }} className="p-1 text-[20px]" style={{ color: "var(--muted)" }}>✕</button>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-y-2 gap-x-3" style={{ padding: "18px 26px 0" }}>
            <div className="inline-flex rounded-[9px] p-0.5" style={{ background: "var(--chip)" }}>
              {([["week", "Week"], ["month", "Month"], ["year", "Year"], ["custom", "Custom"]] as const).map(([pt, label]) => {
                const on = !showUnfinishedGoals && goalsPanelPeriodType === pt;
                return (
                <button key={pt} onClick={() => { setShowUnfinishedGoals(false); setGoalsPanelPeriodType(pt); resetGoalForm(); }}
                  className="text-[12.5px] rounded-[7px]" style={{ padding: "6px 12px", fontWeight: on ? 600 : 400, color: on ? "var(--btn-fg)" : "var(--accent)", background: on ? "var(--pill-active)" : "transparent" }}>{label}</button>
                );
              })}
              {pastUnfinishedGoals.length > 0 && (
                <button onClick={() => { setShowUnfinishedGoals(true); resetGoalForm(); }}
                  className="text-[12.5px] rounded-[7px] inline-flex items-center gap-1.5" style={{ padding: "6px 12px", fontWeight: showUnfinishedGoals ? 600 : 400, color: showUnfinishedGoals ? "var(--btn-fg)" : "var(--accent)", background: showUnfinishedGoals ? "var(--pill-active)" : "transparent" }}>
                  Unfinished
                  <span className="text-[10px] rounded-full px-[6px] py-px" style={{ background: showUnfinishedGoals ? "rgba(255,255,255,0.22)" : "var(--drawer-bd)", color: showUnfinishedGoals ? "var(--btn-fg)" : "var(--muted5)" }}>
                    {pastUnfinishedGoals.length}
                  </span>
                </button>
              )}
            </div>
            {!isCustomPeriod && !showUnfinishedGoals && (
              <div className="flex items-center gap-1">
                <button onClick={() => navigateGoalsPeriod("prev")} className="navbtn" style={{ width: 30, height: 30 }}><ChevronLeft className="w-4 h-4" /></button>
                <span className="text-[12px] text-center min-w-[120px]" style={{ color: "var(--ink2)" }}>
                  {goalsPanelPeriodType === "week"
                    ? `${format(startOfWeek(goalsPanelDate, { weekStartsOn: 0 }), "MMM d")} – ${format(endOfWeek(goalsPanelDate, { weekStartsOn: 0 }), "MMM d")}`
                    : goalsPanelPeriodType === "month"
                      ? format(goalsPanelDate, "MMMM yyyy")
                      : format(goalsPanelDate, "yyyy")}
                </span>
                <button onClick={() => navigateGoalsPeriod("next")} className="navbtn" style={{ width: 30, height: 30 }}><ChevronRight className="w-4 h-4" /></button>
              </div>
            )}
          </div>
          {showUnfinishedGoals ? (
            <div style={{ padding: "14px 22px 4px" }} className="flex flex-col gap-1.5">
              <p className="text-[12.5px] px-1 pb-1" style={{ color: "var(--muted)" }}>
                Goals whose period has ended that you never marked achieved. Bring one forward to pick it up again.
              </p>
              {pastUnfinishedGoals.map((goal) => {
                const counts = goalTaskCounts.get(goal._id);
                const when = goal.periodType === "custom" && goal.endDate
                  ? `ended ${format(new Date(goal.endDate), "MMM d, yyyy")}`
                  : goal.periodType === "week" ? `week of ${format(new Date(goal.periodKey), "MMM d, yyyy")}`
                  : goal.periodType === "month" ? format(new Date(`${goal.periodKey}-01`), "MMMM yyyy")
                  : goal.periodKey;
                return (
                  <div key={goal._id} className="rounded-[12px]" style={{ padding: "12px 14px", background: "var(--field)", border: "1px solid var(--field-bd)" }}>
                    <div className="flex items-start gap-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px]" style={{ color: "var(--ink)" }}>
                          {goalIconOf(goal) && <span className="mr-1.5">{goalIconOf(goal)}</span>}
                          {goal.title}
                        </div>
                        <div className="text-[11.5px] mt-1" style={{ color: "var(--muted)" }}>
                          {when}
                          {counts && counts.total > 0 && ` · ${counts.done} / ${counts.total} tasks`}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => void handleCopyGoalToCurrentPeriod(goal)} title="Bring forward"
                          className="text-[12px] font-semibold rounded-[8px]" style={{ padding: "6px 11px", color: "var(--btn-fg)", background: "var(--btn-primary)" }}>
                          Bring forward
                        </button>
                        <button onClick={() => void handleSetGoalStatus(goal, "achieved")} title="Mark achieved"
                          className="p-1" style={{ color: "var(--accent)" }}><CheckCircle2 className="w-[15px] h-[15px]" /></button>
                        <button onClick={() => void handleSetGoalStatus(goal, "dropped")} title="Drop"
                          className="p-1" style={{ color: "var(--muted2)" }}><X className="w-[15px] h-[15px]" /></button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
          <>
          <div style={{ padding: "14px 22px 4px" }} className="flex flex-col gap-1.5">
            {goalsPanelGoals.length === 0 && !showGoalForm && (
              <div className="text-center rounded-[12px] text-[13px]" style={{ padding: "20px", border: "1px dashed var(--dash2)", color: "var(--muted)" }}>{isCustomPeriod ? "No custom goals yet." : `No goals this ${goalsPanelPeriodType}.`}</div>
            )}
            {goalsPanelGoals.map((goal) => {
              const counts = goalTaskCounts.get(goal._id);
              const parent = goal.parentGoalId ? goalsById.get(goal.parentGoalId) : undefined;
              const durationDays = goalDurationDays(goal);
              const rangeLabel = goal.periodType === "custom" && goal.startDate && goal.endDate
                ? `${durationDays} days · ${format(new Date(goal.startDate), "MMM d")} – ${format(new Date(goal.endDate), "MMM d, yyyy")}`
                : null;
              return (
                <div key={goal._id} className="flex items-start gap-2.5 rounded-[11px]" style={{ padding: "12px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", opacity: goal.status === "dropped" ? 0.55 : 1 }}>
                  <span className={cn("qcheck", goal.status === "achieved" && "checked")} style={{ marginTop: 3 }} onClick={() => handleToggleGoalAchieved(goal)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px]" style={{ color: "var(--ink)", textDecoration: goal.status !== "active" ? "line-through" : undefined }}>{goal.title}</div>
                    {rangeLabel && <div className="text-[11.5px] mt-0.5" style={{ color: "var(--accent)" }}>{rangeLabel}</div>}
                    {goal.note && <div className="text-[12px] mt-0.5" style={{ color: "var(--muted)" }}>{goal.note}</div>}
                    <div className="flex items-center gap-2 mt-1">
                      {counts && <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>{counts.done} / {counts.total} tasks</span>}
                      {parent && <span className="text-[11px]" style={{ color: "var(--accent)" }}>↳ {parent.title}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => void handleToggleGoalPinned(goal)} title={goal.pinned ? "Remove from focus" : "Show in focus"} className="p-0.5"
                      style={{ color: goal.pinned ? "var(--accent)" : "var(--muted2)" }}>
                      <Star className="w-[14px] h-[14px]" style={{ fill: goal.pinned ? "var(--accent)" : "none" }} />
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button title="Move to…" className="p-0.5 outline-none" style={{ color: "var(--muted2)" }}>
                          <ArrowLeftRight className="w-[14px] h-[14px]" />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content align="end" sideOffset={5}
                          className="min-w-[170px] rounded-lg p-1.5 shadow-lg z-[200]"
                          style={{ background: "var(--drawer)", border: "1px solid var(--drawer-bd)" }}>
                          <div className="text-[10px] tracking-[0.1em] uppercase px-3 pt-1 pb-1.5" style={{ color: "var(--muted3)" }}>Move to</div>
                          {([["week", "This week"], ["month", "This month"], ["year", "This year"], ["custom", "Custom (90 days)"]] as const).map(([target, itemLabel]) => {
                            const isCurrent = goal.periodType === target;
                            return (
                              <DropdownMenu.Item key={target} disabled={isCurrent}
                                onSelect={() => { if (!isCurrent) void handleMoveGoal(goal, target); }}
                                className={cn("flex items-center justify-between gap-2 px-3 py-2 rounded-md text-[13px] outline-none", !isCurrent && "cursor-pointer hover:bg-[var(--hover)]")}
                                style={{ color: isCurrent ? "var(--muted3)" : "var(--ink2)" }}>
                                {itemLabel}
                                {isCurrent && <span className="text-[10px]" style={{ color: "var(--muted3)" }}>current</span>}
                              </DropdownMenu.Item>
                            );
                          })}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                    {isViewingPastPeriod && goal.status === "active" && (
                      <button onClick={() => void handleCopyGoalToCurrentPeriod(goal)} title="Copy to current" style={{ color: "var(--accent)" }} className="p-0.5"><Copy className="w-[14px] h-[14px]" /></button>
                    )}
                    <button onClick={() => openGoalForEdit(goal)} style={{ color: "var(--muted2)" }} className="p-0.5"><Edit3 className="w-[14px] h-[14px]" /></button>
                    <button onClick={() => void handleSetGoalStatus(goal, goal.status === "dropped" ? "active" : "dropped")} style={{ color: "var(--muted2)" }} className="p-0.5">{goal.status === "dropped" ? <Repeat className="w-[14px] h-[14px]" /> : <X className="w-[14px] h-[14px]" />}</button>
                    <button onClick={() => void handleDeleteGoal(goal._id)} style={{ color: "var(--tag-fg)" }} className="p-0.5"><Trash2 className="w-[14px] h-[14px]" /></button>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ padding: "6px 22px 26px" }}>
            {showGoalForm ? (
              <div className="rounded-[14px]" style={{ padding: "18px", background: "var(--form-bg)", border: "1px solid var(--form-bd)" }}>
                <div style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[16px] mb-3">{editingGoal ? "Edit goal" : "New goal"}</div>
                <input type="text" autoFocus placeholder={goalsPanelPeriodType === "week" ? "What to achieve this week?" : goalsPanelPeriodType === "month" ? "What to achieve this month?" : goalsPanelPeriodType === "year" ? "What to achieve this year?" : "What to achieve in this window?"} value={goalFormData.title}
                  onChange={(e) => setGoalFormData((p) => ({ ...p, title: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter" && goalFormData.title.trim() && customRangeValid) void (editingGoal ? handleUpdateGoal() : handleAddGoal()); }}
                  className="w-full text-[13.5px] rounded-[10px] outline-none mb-2.5" style={{ padding: "11px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                <input type="text" placeholder="Why it matters · optional" value={goalFormData.note}
                  onChange={(e) => setGoalFormData((p) => ({ ...p, note: e.target.value }))}
                  className="w-full text-[13.5px] rounded-[10px] outline-none mb-2.5" style={{ padding: "11px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                {/* marker — shown beside every task linked to this goal */}
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] tracking-[0.06em] uppercase" style={{ color: "var(--muted5)" }}>Marker</span>
                    {goalFormData.icon && (
                      <button type="button" onClick={() => setGoalFormData((p) => ({ ...p, icon: "" }))}
                        className="text-[11px]" style={{ color: "var(--accent)" }}>Clear</button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {GOAL_ICONS.map((emo) => (
                      <button key={emo} type="button" onClick={() => setGoalFormData((p) => ({ ...p, icon: p.icon === emo ? "" : emo }))}
                        className="w-[30px] h-[30px] rounded-[8px] text-[15px] leading-none flex items-center justify-center transition-colors"
                        style={{ border: goalFormData.icon === emo ? "1px solid var(--accent)" : "1px solid var(--field-bd)", background: goalFormData.icon === emo ? "var(--chip)" : "var(--field)" }}>
                        {emo}
                      </button>
                    ))}
                  </div>
                </div>
                {isCustomPeriod && (
                  <div className="mb-3">
                    <div className="flex gap-2 mb-2">
                      <label className="flex-1">
                        <span className="text-[11px] tracking-[0.06em] uppercase block mb-1" style={{ color: "var(--muted5)" }}>Start</span>
                        <input type="date" value={goalFormData.startDate}
                          onChange={(e) => setGoalFormData((p) => ({ ...p, startDate: e.target.value }))}
                          className="w-full text-[13px] rounded-[10px] outline-none" style={{ padding: "9px 12px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                      </label>
                      <label className="flex-1">
                        <span className="text-[11px] tracking-[0.06em] uppercase block mb-1" style={{ color: "var(--muted5)" }}>End</span>
                        <input type="date" value={goalFormData.endDate} min={goalFormData.startDate || undefined}
                          onChange={(e) => setGoalFormData((p) => ({ ...p, endDate: e.target.value }))}
                          className="w-full text-[13px] rounded-[10px] outline-none" style={{ padding: "9px 12px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                      </label>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {[30, 60, 90].map((d) => (
                        <button key={d} type="button" onClick={() => applyCustomPreset(d)}
                          className="text-[11.5px] rounded-[8px]" style={{ padding: "5px 11px", color: "var(--accent)", background: "var(--chip)" }}>{d} days</button>
                      ))}
                    </div>
                    {!customRangeValid && (goalFormData.startDate || goalFormData.endDate) && (
                      <div className="text-[11.5px] mt-1.5" style={{ color: "var(--tag-fg)" }}>Pick a start and end date; end can&apos;t be before start.</div>
                    )}
                  </div>
                )}
                {canLinkParent && parentGoalOptions.length > 0 && (
                  <select value={goalFormData.parentGoalId} onChange={(e) => setGoalFormData((p) => ({ ...p, parentGoalId: e.target.value }))}
                    className="w-full text-[13.5px] rounded-[10px] outline-none mb-3" style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}>
                    <option value="">{parentLinkPlaceholder}</option>
                    {parentGoalOptions.map((g) => <option key={g._id} value={g._id}>{g.title}</option>)}
                  </select>
                )}
                <div className="flex gap-2.5">
                  <button onClick={editingGoal ? handleUpdateGoal : handleAddGoal} disabled={!goalFormData.title.trim() || !customRangeValid || goalsLoading}
                    className="cta text-[13px] font-semibold rounded-[10px] disabled:opacity-50" style={{ padding: "9px 20px", color: "var(--btn-fg)", background: "var(--btn-primary)" }}>{goalsLoading ? "Saving…" : editingGoal ? "Update" : "Add goal"}</button>
                  <button onClick={resetGoalForm} className="text-[13px]" style={{ padding: "9px 16px", color: "var(--accent)" }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button onClick={() => { resetGoalForm(); setShowGoalForm(true); }} className="hovrow w-full text-[13px] text-center rounded-[11px]" style={{ padding: "11px", border: "1px dashed var(--check-bd)", color: "var(--muted5)" }}>+ Add a goal</button>
            )}
          </div>
          </>
          )}
        </div>
      )}

      {/* Payments drawer */}
      {paymentsDrawerOpen && paymentsData?.configured && (
        <div className="fixed top-0 right-0 bottom-0 z-[61] w-[460px] max-w-[94vw] overflow-y-auto"
          style={{ background: "var(--drawer)", borderLeft: "1px solid var(--drawer-bd)", boxShadow: "-24px 0 60px -30px rgba(70,55,30,0.4)", animation: "drawerIn .28s cubic-bezier(.16,1,.3,1)" }}>
          <div className="flex items-start justify-between" style={{ padding: "24px 26px 0" }}>
            <div>
              <div style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px]">Payments due</div>
              <div className="text-[13px] mt-0.5" style={{ color: "var(--muted)" }}>{format(parseYmd(paymentsDate), "EEEE, MMMM d")}</div>
            </div>
            <button onClick={() => setPaymentsDrawerOpen(false)} className="p-1 text-[20px]" style={{ color: "var(--muted)" }}>✕</button>
          </div>
          <div style={{ padding: "18px 22px 26px" }} className="flex flex-col gap-2">
            {[...(paymentsData.accounts ?? []).map((a) => ({ id: a.id, name: a.shortName, total: a.total, items: a.items })),
              ...((paymentsData.budgets ?? []).length > 0 ? [{ id: "budgets", name: "Other payments", total: (paymentsData.budgets ?? []).reduce((s, b) => s + b.amount, 0), items: paymentsData.budgets ?? [] }] : [])
            ].map((row) => {
              const isPaid = paidPaymentAccounts.has(row.id);
              const isExpanded = expandedPaymentAccounts.has(row.id);
              return (
                <div key={row.id} className="rounded-[11px]" style={{ background: "var(--field)", border: "1px solid var(--field-bd)" }}>
                  <div className="flex items-center gap-3" style={{ padding: "12px 14px" }}>
                    <span className={cn("qcheck", isPaid && "checked")} onClick={() => togglePaymentAccountPaid(row.id)} />
                    <button className="flex-1 text-left" onClick={() => togglePaymentAccountExpanded(row.id)}>
                      <div className="text-[14px]" style={{ color: "var(--ink)", textDecoration: isPaid ? "line-through" : undefined }}>{row.name}</div>
                      <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>{row.items.length} item{row.items.length === 1 ? "" : "s"}</div>
                    </button>
                    <span className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>{fmtMoney(row.total)}</span>
                  </div>
                  {isExpanded && (
                    <div style={{ padding: "0 14px 12px 40px" }} className="flex flex-col gap-1.5">
                      {row.items.map((it, idx) => (
                        <div key={idx} className="flex items-center justify-between text-[12.5px]">
                          <span style={{ color: "var(--ink3)" }}>{it.label}</span>
                          <span style={{ color: "var(--muted)" }}>{fmtMoney(it.amount)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="flex items-center justify-between mt-2 pt-3 text-[13px]" style={{ borderTop: "1px solid var(--line2)" }}>
              <span style={{ color: "var(--muted)" }}>Income</span>
              <span style={{ color: "var(--ink3)" }}>{fmtMoney(paymentsData.totalIncome ?? 0)}</span>
            </div>
            <div className="flex items-center justify-between text-[13px]">
              <span style={{ color: "var(--muted)" }}>Day ends</span>
              <span className="font-semibold" style={{ color: (paymentsData.finalBalance ?? 0) >= 0 ? "#16a34a" : "var(--tag-fg)" }}>{(paymentsData.finalBalance ?? 0) >= 0 ? "+" : "−"}{fmtMoney(paymentsData.finalBalance ?? 0)}</span>
            </div>
          </div>
        </div>
      )}
      {/* Checklist library drawer — reusable procedures, authored in Myndlist */}
      {myndlistDrawerOpen && (
        <div className="fixed top-0 right-0 bottom-0 z-[61] w-[470px] max-w-[94vw] overflow-y-auto"
          style={{ background: "var(--drawer)", borderLeft: "1px solid var(--drawer-bd)", boxShadow: "-24px 0 60px -30px rgba(70,55,30,0.4)", animation: "drawerIn .28s cubic-bezier(.16,1,.3,1)" }}>
          <div className="flex items-start justify-between" style={{ padding: "24px 26px 0" }}>
            <div>
              <div style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px]">Checklists</div>
              <div className="text-[13px] mt-0.5 leading-[1.5]" style={{ color: "var(--muted)" }}>
                Procedures you run more than once. Attach one to a task and it copies in fresh.
              </div>
            </div>
            <button onClick={closeChecklistLibrary} className="p-1 text-[20px]" style={{ color: "var(--muted)" }}>✕</button>
          </div>

          <div style={{ padding: "20px 22px 0" }} className="flex flex-col gap-2">
            {!myndlistConfigured ? (
              <div className="rounded-[13px] text-[13px] leading-[1.55]" style={{ padding: "16px", background: "var(--form-bg)", border: "1px solid var(--form-bd)", color: "var(--muted)" }}>
                Connect Myndlist in <button onClick={() => { closeChecklistLibrary(); setSettingsSection("integrations"); setDraftMyndlistUrl(myndlistApiUrl); setDraftMyndlistKey(myndlistApiKey); setMyndlistTestResult(null); setIsSettingsOpen(true); }} className="font-semibold" style={{ color: "var(--accent)" }}>Settings → Integrations</button> to reuse its checklists here.
              </div>
            ) : myndlistLoading && myndlistTemplates.length === 0 ? (
              <>
                {[0, 1, 2].map((i) => <div key={i} className="skel h-[62px] rounded-[13px]" />)}
              </>
            ) : myndlistError ? (
              <div className="rounded-[13px] text-[13px]" style={{ padding: "14px 16px", background: "var(--form-bg)", border: "1px solid var(--tag-fg)", color: "var(--tag-fg)" }}>
                {myndlistError}
                <button onClick={() => void fetchMyndlistTemplates(true)} className="ml-2 font-semibold underline">Retry</button>
              </div>
            ) : myndlistTemplates.length === 0 ? (
              <div className="rounded-[13px] text-[13px] leading-[1.55]" style={{ padding: "16px", background: "var(--form-bg)", border: "1px solid var(--form-bd)", color: "var(--muted)" }}>
                No checklists yet. Create one below — a packing list, a client handoff, anything you do the same way twice.
              </div>
            ) : (
              myndlistTemplates.map((template) => {
                const isEditing = expandedTemplateId === template.id && templateDraft !== null;
                if (!isEditing) {
                  return (
                    <div key={template.id} onClick={() => startEditTemplate(template)}
                      className="hovrow flex items-center gap-3 rounded-[13px] cursor-pointer"
                      style={{ padding: "14px 16px", background: "var(--field)", border: "1px solid var(--field-bd)" }}>
                      <div className="flex-1 min-w-0">
                        <div className="text-[14px] truncate" style={{ color: "var(--ink)" }}>{template.name}</div>
                        <div className="text-[11.5px] mt-0.5" style={{ color: "var(--muted)" }}>
                          {templateStepSummary(template)} · used {template.usageCount}×
                        </div>
                      </div>
                      <span className="text-[13px]" style={{ color: "var(--muted2)" }}>✎</span>
                    </div>
                  );
                }
                return (
                  <div key={template.id} className="rounded-[13px] overflow-hidden"
                    style={{ background: "var(--field)", border: "1px solid var(--accent)" }}>
                    <div className="flex items-center gap-3" style={{ padding: "14px 16px" }}>
                      <input
                        value={templateDraft.name}
                        onChange={(e) => setTemplateDraft({ ...templateDraft, name: e.target.value })}
                        className="flex-1 bg-transparent outline-none text-[18px]"
                        style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }}
                      />
                      <span className="text-[11.5px] shrink-0" style={{ color: "var(--muted)" }}>used {template.usageCount}×</span>
                    </div>

                    <div style={{ padding: "0 16px" }} className="flex flex-col">
                      {templateDraft.steps.map((step, i) => (
                        <div key={step.id} className="hovrow flex items-start gap-2.5 rounded-[8px]" style={{ padding: "8px", margin: "0 -8px" }}>
                          <span className="text-[11px] w-[15px] text-right shrink-0" style={{ color: "var(--num)", marginTop: 3 }}>{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <input
                              value={step.text}
                              onChange={(e) => setTemplateDraft({
                                ...templateDraft,
                                steps: templateDraft.steps.map((x) => (x.id === step.id ? { ...x, text: e.target.value } : x)),
                              })}
                              aria-label={`Step ${i + 1}`}
                              className="w-full bg-transparent outline-none text-[13.5px]"
                              style={{ color: "var(--ink2)" }}
                            />
                            {step.note?.trim() && (
                              <div className="text-[11.5px] mt-0.5 whitespace-pre-wrap break-words" style={{ color: "var(--muted)" }}
                                title="Notes are edited in Myndlist and kept when you save here">
                                <LinkifiedText text={step.note} linkStyle={{ color: "var(--accent)" }} />
                              </div>
                            )}
                          </div>
                          {/* Always visible while editing: whether a step is optional decides what blocks the task. */}
                          <button
                            onClick={() => setTemplateDraft({
                              ...templateDraft,
                              steps: templateDraft.steps.map((x) => (x.id === step.id ? { ...x, optional: !x.optional } : x)),
                            })}
                            role="switch" aria-checked={Boolean(step.optional)}
                            aria-label={`Step ${i + 1} optional`}
                            title={step.optional ? "Optional: never blocks the task. Click to make required." : "Required. Click to make optional."}
                            className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.08em] rounded-full whitespace-nowrap"
                            style={step.optional
                              ? { padding: "2px 8px", border: "1px dashed var(--accent)", color: "var(--accent)" }
                              : { padding: "2px 8px", border: "1px solid var(--line)", color: "var(--muted3)" }}>
                            {step.optional ? "Optional" : "Required"}
                          </button>
                          <button
                            onClick={() => setTemplateDraft({ ...templateDraft, steps: templateDraft.steps.filter((x) => x.id !== step.id) })}
                            className="shrink-0 p-0.5 rounded" style={{ color: "var(--muted2)" }} title="Remove step">
                            <Trash2 className="w-[13px] h-[13px]" />
                          </button>
                        </div>
                      ))}
                    </div>

                    <div style={{ padding: "12px 16px 0" }}>
                      <input
                        value={newTemplateStep}
                        onChange={(e) => setNewTemplateStep(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && newTemplateStep.trim()) {
                            e.preventDefault();
                            setTemplateDraft({
                              ...templateDraft,
                              steps: [...templateDraft.steps, { id: `new-${Date.now()}`, text: newTemplateStep.trim() }],
                            });
                            setNewTemplateStep("");
                          }
                        }}
                        placeholder="Add a step…"
                        className="w-full text-[13px] rounded-[10px] outline-none placeholder:text-[color:var(--muted3)]"
                        style={{ padding: "10px 13px", background: "var(--form-bg)", border: "1px solid var(--form-bd)", color: "var(--ink)" }}
                      />
                    </div>

                    <div className="flex items-start gap-2.5 rounded-[11px]" style={{ margin: "14px 16px 0", padding: "12px 14px", background: "var(--tint)" }}>
                      <button
                        onClick={() => setTemplateDraft({ ...templateDraft, blockCompletion: !templateDraft.blockCompletion })}
                        className="relative shrink-0 rounded-full"
                        style={{ width: 32, height: 18, background: templateDraft.blockCompletion ? "var(--pill-active)" : "var(--line)" }}
                        role="switch" aria-checked={templateDraft.blockCompletion}>
                        <span className="absolute rounded-full" style={{ top: 2, left: templateDraft.blockCompletion ? 16 : 2, width: 14, height: 14, background: "var(--drawer)", transition: "left .15s ease" }} />
                      </button>
                      <div>
                        <div className="text-[12.5px]" style={{ color: "var(--ink2)" }}>Block the task until every required step is ticked</div>
                        <div className="text-[11.5px] mt-0.5" style={{ color: "var(--muted)" }}>Off by default — steps are a memory aid, not a gate. Optional steps never block.</div>
                      </div>
                    </div>

                    <p className="text-[11.5px]" style={{ padding: "12px 16px 0", color: "var(--muted)" }}>
                      Changes apply to checklists you attach from now on. Copies already on a task stay as they were.
                    </p>

                    <div className="flex items-center justify-between" style={{ padding: "16px" }}>
                      <button onClick={() => void handleDeleteTemplate(template.id)}
                        className="text-[12.5px] font-semibold" style={{ color: "#dc2626" }}>
                        Delete checklist
                      </button>
                      <div className="flex items-center gap-2">
                        <button onClick={() => { setExpandedTemplateId(null); setTemplateDraft(null); }}
                          className="text-[12.5px] font-medium rounded-[10px]" style={{ padding: "9px 16px", background: "var(--chip)", color: "var(--ink2)" }}>
                          Cancel
                        </button>
                        <button onClick={() => void handleSaveTemplate(template.id)} disabled={templateSaving}
                          className="cta text-[12.5px] font-semibold rounded-[10px] disabled:opacity-50"
                          style={{ padding: "9px 20px", background: "var(--btn-primary)", color: "var(--btn-fg)" }}>
                          {templateSaving ? "Saving…" : "Done"}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {myndlistConfigured && (
            <div style={{ padding: "16px 22px 26px" }}>
              <button
                onClick={async () => {
                  const created = await handleCreateTemplate("Untitled checklist");
                  if (created) startEditTemplate(created);
                }}
                disabled={templateSaving}
                className="hovrow w-full text-[13px] rounded-[11px] disabled:opacity-50"
                style={{ padding: "11px", textAlign: "center", border: "1px dashed var(--check-bd)", color: "var(--muted5)" }}>
                + New checklist
              </button>
            </div>
          )}
        </div>
      )}

      {/* Search command palette */}
      {searchOpen && (
        <>
          <div onClick={() => setSearchOpen(false)} className="fixed inset-0 z-[70]" style={{ background: "var(--overlay)", animation: "fadeIn .15s ease" }} />
          <div className="fixed left-1/2 -translate-x-1/2 top-[12vh] z-[71] w-[580px] max-w-[92vw] rounded-[16px] overflow-hidden"
            style={{ background: "var(--drawer)", border: "1px solid var(--drawer-bd)", boxShadow: "0 30px 70px -30px rgba(70,55,30,0.5)" }}>
            <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: "1px solid var(--line2)" }}>
              <Search className="w-4 h-4" style={{ color: "var(--muted)" }} />
              <input
                autoFocus
                type="text"
                placeholder="Search tasks and routines…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setSearchOpen(false); }}
                className="flex-1 bg-transparent outline-none text-[15px]"
                style={{ color: "var(--ink)" }}
              />
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: "var(--chip)", color: "var(--muted)" }}>esc</span>
            </div>
            <div className="max-h-[52vh] overflow-y-auto py-2">
              {(() => {
                const q = searchQuery.trim().toLowerCase();
                const matchTasks = q
                  ? tasks.filter(t => t.title.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q))
                  : [];
                const matchRoutine = q ? checklistItems.filter(i => i.title.toLowerCase().includes(q)) : [];
                const matchTemplates = q ? myndlistTemplates.filter(t => t.name.toLowerCase().includes(q)) : [];
                if (!q) {
                  return <div className="px-4 py-6 text-[13px] text-center" style={{ color: "var(--muted)" }}>Start typing to find a task, routine item or checklist.</div>;
                }
                if (matchTasks.length === 0 && matchRoutine.length === 0 && matchTemplates.length === 0) {
                  return <div className="px-4 py-6 text-[13px] text-center" style={{ color: "var(--muted)" }}>No matches for &ldquo;{searchQuery}&rdquo;.</div>;
                }
                return (
                  <>
                    {MATRIX_ORDER.map((quadrant) => {
                      const rows = matchTasks.filter(t => t.quadrant === quadrant);
                      if (rows.length === 0) return null;
                      const meta = MATRIX_META[quadrant];
                      return (
                        <div key={quadrant} className="mb-1">
                          <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--muted2)" }}>{meta.name} · {rows.length}</div>
                          {rows.map((t) => (
                            <button key={t._id}
                              onClick={() => { setSearchOpen(false); void openTaskForEdit(t); }}
                              className="hovrow w-full flex items-center gap-3 px-4 py-2 text-left">
                              <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: meta.color }} />
                              <span className="flex-1 text-[14px] truncate" style={{ color: t.status === "completed" ? "var(--strike)" : "var(--ink2)", textDecoration: t.status === "completed" ? "line-through" : undefined }}>{t.title}</span>
                              {isTaskOverdue(t) && <span className="text-[10px] px-[7px] py-px rounded-[5px]" style={{ color: "var(--tag-fg)", background: "var(--tag-bg)" }}>Overdue</span>}
                              {t.dueDate && !isTaskOverdue(t) && <span className="text-[11px]" style={{ color: "var(--muted)" }}>{format(new Date(t.dueDate), "MMM d")}</span>}
                            </button>
                          ))}
                        </div>
                      );
                    })}
                    {matchRoutine.length > 0 && (
                      <div className="mb-1">
                        <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--muted2)" }}>Routine · {matchRoutine.length}</div>
                        {matchRoutine.map((i) => (
                          <button key={i._id}
                            onClick={() => { setSearchOpen(false); setRoutineDrawerOpen(true); }}
                            className="hovrow w-full flex items-center gap-3 px-4 py-2 text-left">
                            <Repeat className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                            <span className="flex-1 text-[14px] truncate" style={{ color: "var(--ink2)" }}>{i.title}</span>
                            <span className="text-[11px]" style={{ color: "var(--muted)" }}>{i.frequency}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {matchTemplates.length > 0 && (
                      <div className="mb-1">
                        <div className="px-4 pt-2 pb-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--muted2)" }}>Checklists · {matchTemplates.length}</div>
                        {matchTemplates.map((t) => (
                          <button key={t.id}
                            onClick={() => { setSearchOpen(false); openChecklistLibrary(t.id); }}
                            className="hovrow w-full flex items-center gap-3 px-4 py-2 text-left">
                            <ListChecks className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                            <span className="flex-1 text-[14px] truncate" style={{ color: "var(--ink2)" }}>{t.name}</span>
                            <span className="text-[11px]" style={{ color: "var(--muted)" }}>{templateStepSummary(t)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
            <div className="flex items-center gap-4 px-4 py-2 text-[11px]" style={{ borderTop: "1px solid var(--line2)", color: "var(--muted)" }}>
              <span>↵ open</span><span>esc close</span>
            </div>
          </div>
        </>
      )}

      {/* Floating Action Button */}
      <button
        onClick={() => openModalForQuadrant("urgent-important")}
        className="cta fixed bottom-20 right-4 md:bottom-24 md:right-6 p-3 md:p-4 rounded-full shadow-lg transition-colors z-40"
        style={{ background: "var(--btn-primary)", color: "var(--btn-fg)" }}
        title="Add a task"
      >
        <Plus className="w-5 h-5 md:w-6 md:h-6" />
      </button>

      {/* Task editor */}
      {isModalOpen && (
        <div className="fixed inset-0 flex items-center justify-center p-4 z-50" style={{ background: "var(--overlay)" }}>
          <div className="w-full max-w-[520px] max-h-[90vh] flex flex-col rounded-[18px] overflow-hidden"
            style={{ background: "var(--drawer)", border: "1px solid var(--drawer-bd)", color: "var(--ink)", boxShadow: "0 30px 70px -30px rgba(70,55,30,0.5)" }}>

            {/* header */}
            <div className="flex items-center justify-between shrink-0" style={{ padding: "15px 22px", borderBottom: "1px solid var(--line2)", background: "var(--form-bg)" }}>
              <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted5)" }}>
                {editingTask ? "Edit task" : "New task"}
              </span>
              <div className="flex items-center gap-1">
                {formData.dueDate && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="p-1 rounded-lg hover:bg-[var(--hover)] outline-none" title="Add to calendar / export iCal">
                        <Share2 className="w-[17px] h-[17px]" style={{ color: "var(--muted5)" }} />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CLS}>
                        {([
                          { id: "google", label: "Google Calendar", color: "#ef4444" },
                          { id: "outlook", label: "Outlook.com", color: "var(--accent)" },
                          { id: "office365", label: "Office 365", color: "#2563eb" },
                          { id: "yahoo", label: "Yahoo Calendar", color: "#a855f7" },
                        ] as const).map((p) => (
                          <DropdownMenu.Item key={p.id} className={MENU_ITEM}
                            onSelect={() => { exportEditingTaskToCalendar(p.id); toast.success(`Opening ${p.label}`); }}>
                            <Calendar className="w-4 h-4" style={{ color: p.color }} />
                            {p.label}
                          </DropdownMenu.Item>
                        ))}
                        <DropdownMenu.Separator className="h-px my-1 bg-[var(--line3)]" />
                        <DropdownMenu.Item className={MENU_ITEM}
                          onSelect={() => { exportEditingTaskToCalendar("ics"); toast.success("Downloading .ics file"); }}>
                          <Download className="w-4 h-4 text-[var(--muted)]" />
                          Download .ics
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}
                <button onClick={closeModal} className="p-1 rounded-lg hover:bg-[var(--hover)]" style={{ color: "var(--muted5)" }}>
                  <X className="w-[18px] h-[18px]" />
                </button>
              </div>
            </div>

            {/* body */}
            <div className="flex-1 overflow-y-auto" style={{ padding: "22px" }}>
              <input
                type="text"
                autoFocus={!editingTask}
                value={formData.title}
                onChange={(e) => setFormData(prev => ({ ...prev, title: e.target.value }))}
                placeholder="Task name"
                className="w-full bg-transparent outline-none text-[24px] font-semibold leading-tight placeholder:text-[color:var(--muted3)]"
                style={{ color: "var(--ink)" }}
              />
              <textarea
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Add a description…"
                rows={2}
                className="w-full bg-transparent outline-none text-[14.5px] mt-2 resize-none placeholder:text-[color:var(--muted3)]"
                style={{ color: "var(--ink3)" }}
              />

              {/* attribute chips */}
              <div className="flex flex-wrap gap-2 mt-3">
                {/* priority — urgent & important is always high, so no choice to make */}
                {formData.quadrant !== "urgent-important" && (
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className={CHIP_BASE} style={CHIP_SET}>
                        <span className="w-[8px] h-[8px] rounded-full shrink-0" style={{ background: PRIORITY_META[formData.priority].color }} />
                        {PRIORITY_META[formData.priority].label}
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CLS}>
                        {(["high", "medium", "low"] as const).map((p) => (
                          <DropdownMenu.Item key={p} className={MENU_ITEM}
                            onSelect={() => setFormData(prev => ({ ...prev, priority: p }))}>
                            <span className="w-[8px] h-[8px] rounded-full shrink-0" style={{ background: PRIORITY_META[p].color }} />
                            {PRIORITY_META[p].label} priority
                          </DropdownMenu.Item>
                        ))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                )}

                {/* quadrant */}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button className={CHIP_BASE} style={CHIP_SET}>
                      <span className="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ background: MATRIX_META[formData.quadrant].color }} />
                      {QUADRANT_SHORT[formData.quadrant]}
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CLS}>
                      {MATRIX_ORDER.map((q) => (
                        <DropdownMenu.Item key={q} className={MENU_ITEM}
                          onSelect={() => setFormData(prev => ({ ...prev, quadrant: q, priority: q === "urgent-important" ? "high" : prev.priority }))}>
                          <span className="w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ background: MATRIX_META[q].color }} />
                          {QUADRANT_SHORT[q]}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>

                {/* due date + time */}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button className={CHIP_BASE} style={formData.dueDate ? CHIP_SET : CHIP_UNSET}>
                      {formData.dueDate ? (
                        <>
                          <CalendarDays className="w-[13px] h-[13px] shrink-0" />
                          {format(parseYmd(formData.dueDate), "MMM d")}
                        </>
                      ) : "+ Due date"}
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CLS}>
                      {([["today", "Today"], ["tomorrow", "Tomorrow"], ["nextWeek", "Next week"]] as const).map(([when, label]) => (
                        <DropdownMenu.Item key={when} className={MENU_ITEM}
                          onSelect={() => {
                            const base = when === "today" ? new Date() : when === "tomorrow" ? addDays(new Date(), 1) : addDays(new Date(), 7);
                            setFormData(prev => ({ ...prev, dueDate: format(base, "yyyy-MM-dd") }));
                          }}>
                          <CalendarDays className="w-4 h-4" style={{ color: "var(--muted2)" }} />
                          {label}
                        </DropdownMenu.Item>
                      ))}
                      <DropdownMenu.Separator className="h-px my-1 bg-[var(--line3)]" />
                      <div className="p-1.5 flex flex-col gap-2" onKeyDown={(e) => e.stopPropagation()}>
                        <input type="date" min={format(new Date(), "yyyy-MM-dd")} value={formData.dueDate}
                          onChange={(e) => {
                            if (e.target.value && e.target.value < format(new Date(), "yyyy-MM-dd")) return;
                            setFormData(prev => ({ ...prev, dueDate: e.target.value }));
                          }}
                          className="w-full text-[13px] rounded-[9px] outline-none" style={{ padding: "8px 11px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                        <input type="time" value={formData.dueTime} disabled={!formData.dueDate}
                          onChange={(e) => setFormData(prev => ({ ...prev, dueTime: e.target.value }))}
                          className="w-full text-[13px] rounded-[9px] outline-none disabled:opacity-50" style={{ padding: "8px 11px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }} />
                      </div>
                      {formData.dueDate && (
                        <DropdownMenu.Item className={MENU_ITEM}
                          onSelect={() => setFormData(prev => ({ ...prev, dueDate: "", dueTime: "12:00" }))}>
                          <X className="w-4 h-4" style={{ color: "var(--muted2)" }} />
                          Clear date
                        </DropdownMenu.Item>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>

                {/* duration */}
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button className={CHIP_BASE} style={typeof formData.duration === "number" ? CHIP_SET : CHIP_UNSET}>
                      {typeof formData.duration === "number" ? (
                        <>
                          <Clock className="w-[13px] h-[13px] shrink-0" />
                          {formatShortDuration(formData.duration)}
                        </>
                      ) : "+ Duration"}
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CLS}>
                      {DURATION_OPTIONS.map((min) => (
                        <DropdownMenu.Item key={min} className={MENU_ITEM}
                          onSelect={() => setFormData(prev => ({ ...prev, duration: min }))}>
                          <Clock className="w-4 h-4" style={{ color: "var(--muted2)" }} />
                          {formatShortDuration(min)}
                        </DropdownMenu.Item>
                      ))}
                      {typeof formData.duration === "number" && (
                        <>
                          <DropdownMenu.Separator className="h-px my-1 bg-[var(--line3)]" />
                          <DropdownMenu.Item className={MENU_ITEM}
                            onSelect={() => setFormData(prev => ({ ...prev, duration: "" }))}>
                            <X className="w-4 h-4" style={{ color: "var(--muted2)" }} />
                            No duration
                          </DropdownMenu.Item>
                        </>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>

                {/* goal */}
                {(() => {
                  const today = format(new Date(), "yyyy-MM-dd");
                  const options = [
                    ...currentWeekGoals.filter(g => g.status === "active"),
                    ...currentMonthGoals.filter(g => g.status === "active"),
                    ...currentYearGoals.filter(g => g.status === "active"),
                    ...goals.filter(g => g.periodType === "custom" && g.status === "active" && (g.startDate ?? "") <= today && (g.endDate ?? "") >= today),
                  ];
                  const selected = formData.goalId ? goalsById.get(formData.goalId) : undefined;
                  if (options.length === 0 && !selected) return null;
                  return (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button className={cn(CHIP_BASE, "max-w-[220px]")} style={selected ? CHIP_SET : CHIP_UNSET}>
                          {selected ? (
                            <>
                              <Star className="w-[13px] h-[13px] shrink-0" style={{ fill: "var(--accent)", color: "var(--accent)" }} />
                              <span className="truncate">{selected.title}</span>
                            </>
                          ) : "+ Goal"}
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CLS}>
                          {selected && !options.some(g => g._id === selected._id) && (
                            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => { /* keep */ }}>
                              <Star className="w-4 h-4" style={{ fill: "var(--accent)", color: "var(--accent)" }} />
                              <span className="truncate">{goalOptionLabel(selected)}</span>
                            </DropdownMenu.Item>
                          )}
                          {options.map((g) => (
                            <DropdownMenu.Item key={g._id} className={MENU_ITEM}
                              onSelect={() => setFormData(prev => ({ ...prev, goalId: g._id }))}>
                              <Star className="w-4 h-4 shrink-0" style={{ color: formData.goalId === g._id ? "var(--accent)" : "var(--muted2)", fill: formData.goalId === g._id ? "var(--accent)" : "none" }} />
                              <span className="truncate">{g.title}</span>
                            </DropdownMenu.Item>
                          ))}
                          {formData.goalId && (
                            <>
                              <DropdownMenu.Separator className="h-px my-1 bg-[var(--line3)]" />
                              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setFormData(prev => ({ ...prev, goalId: "" }))}>
                                <X className="w-4 h-4" style={{ color: "var(--muted2)" }} />
                                No goal
                              </DropdownMenu.Item>
                            </>
                          )}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  );
                })()}

                {/* nest under another task — only for tasks that aren't parents themselves */}
                {editingTask && (editingTask.subtaskCount ?? 0) === 0 && (() => {
                  const selectedParent = formData.linkedParentId ? tasks.find(t => t._id === formData.linkedParentId) : undefined;
                  const nestCandidates = tasks
                    .filter(t => t._id !== editingTask._id && t.linkedParentId !== editingTask._id)
                    .filter(t => nestQuadrantFilter === "all" || t.quadrant === nestQuadrantFilter)
                    .filter(t => t.title.toLowerCase().includes(nestSearch.trim().toLowerCase()));
                  return (
                    <DropdownMenu.Root onOpenChange={(o) => { if (!o) setNestSearch(""); }}>
                      <DropdownMenu.Trigger asChild>
                        <button className={cn(CHIP_BASE, "max-w-[220px]")} style={selectedParent ? CHIP_SET : CHIP_UNSET}>
                          {selectedParent ? (
                            <>
                              <Link2 className="w-[13px] h-[13px] shrink-0" />
                              <span className="truncate">{selectedParent.title}</span>
                            </>
                          ) : "+ Nest under"}
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content align="start" sideOffset={6} className="w-[300px] rounded-[12px] p-0 shadow-lg z-[200] bg-[var(--drawer)] border border-[var(--drawer-bd)] overflow-hidden">
                          <div className="p-2" style={{ borderBottom: "1px solid var(--line2)" }} onKeyDown={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md" style={{ background: "var(--tint)" }}>
                              <Search className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                              <input type="text" value={nestSearch} onChange={(e) => setNestSearch(e.target.value)}
                                placeholder="Search tasks…" className="flex-1 bg-transparent text-sm outline-none" style={{ color: "var(--ink)" }} />
                            </div>
                            <div className="flex flex-wrap gap-1 mt-2">
                              <button type="button" onClick={() => setNestQuadrantFilter("all")}
                                className="text-[11px] px-2.5 py-1 rounded-full" style={{ background: nestQuadrantFilter === "all" ? "var(--pill-active)" : "var(--chip)", color: nestQuadrantFilter === "all" ? "var(--btn-fg)" : "var(--ink3)" }}>All</button>
                              {MATRIX_ORDER.map((q) => (
                                <button key={q} type="button" onClick={() => setNestQuadrantFilter(q)}
                                  className="text-[11px] px-2.5 py-1 rounded-full flex items-center gap-1.5" style={{ background: nestQuadrantFilter === q ? "var(--pill-active)" : "var(--chip)", color: nestQuadrantFilter === q ? "var(--btn-fg)" : "var(--ink3)" }}>
                                  <span className="w-[6px] h-[6px] rounded-full" style={{ background: MATRIX_META[q].color }} />
                                  {MATRIX_META[q].name}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="max-h-[220px] overflow-y-auto py-1">
                            <DropdownMenu.Item className={MENU_ITEM} onSelect={() => setFormData(prev => ({ ...prev, linkedParentId: "" }))}>
                              <span className="w-[7px] h-[7px] shrink-0" />
                              Not nested
                              {!formData.linkedParentId && <CheckCircle2 className="w-3.5 h-3.5 ml-auto" style={{ color: "var(--accent)" }} />}
                            </DropdownMenu.Item>
                            {nestCandidates.map((t) => (
                              <DropdownMenu.Item key={t._id} className={MENU_ITEM}
                                onSelect={() => setFormData(prev => ({ ...prev, linkedParentId: t._id }))}>
                                <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: MATRIX_META[t.quadrant].color }} />
                                <span className="truncate">{t.title}</span>
                                {formData.linkedParentId === t._id && <CheckCircle2 className="w-3.5 h-3.5 ml-auto shrink-0" style={{ color: "var(--accent)" }} />}
                              </DropdownMenu.Item>
                            ))}
                            {nestCandidates.length === 0 && (
                              <div className="px-3 py-3 text-sm text-center" style={{ color: "var(--muted)" }}>No matching tasks</div>
                            )}
                          </div>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  );
                })()}
              </div>

              {/* subtasks */}
              {editingTask && !editingTask.parentTaskId && (
                <div className="mt-5 pt-5" style={{ borderTop: "1px solid var(--line2)" }}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted5)" }}>Subtasks</span>
                    {subtasks.length > 0 && (
                      <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                        {subtasks.filter(s => s.status === "completed").length}/{subtasks.length} done
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] mb-2.5" style={{ color: "var(--muted3)" }}>
                    Work that belongs only to this task. Must be finished before it closes.
                  </div>
                  {subtasks.length > 0 && (
                    <div className="h-[4px] rounded-full overflow-hidden mb-3" style={{ background: "var(--line3)" }}>
                      <div className="h-full rounded-full" style={{ width: `${(subtasks.filter(s => s.status === "completed").length / subtasks.length) * 100}%`, background: "var(--pill-active)" }} />
                    </div>
                  )}

                  {subtasksLoading ? (
                    <div className="flex flex-col gap-2">
                      {[1, 2, 3].map((i) => (
                        <div key={i} className="flex items-center gap-2.5 py-1.5">
                          <div className="w-[18px] h-[18px] rounded-full skel shrink-0" />
                          <div className="flex-1 h-4 skel" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col">
                      {subtasks.map((subtask) => (
                        <div key={subtask._id} className="group flex items-center gap-2.5 py-[7px]">
                          <button onClick={() => handleToggleSubtaskComplete(subtask)} className="shrink-0 rounded-full outline-none">
                            {subtask.status === "completed"
                              ? <CheckCircle2 className="w-[18px] h-[18px]" style={{ color: "var(--accent)" }} />
                              : <span className="block w-[17px] h-[17px] rounded-full" style={{ border: "1.5px solid var(--check-bd)" }} />}
                          </button>
                          {editingSubtaskId === subtask._id ? (
                            <input
                              type="text"
                              autoFocus
                              value={editingSubtaskTitle}
                              onChange={(e) => setEditingSubtaskTitle(e.target.value)}
                              onBlur={() => void handleUpdateSubtaskTitle(subtask._id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); void handleUpdateSubtaskTitle(subtask._id); }
                                else if (e.key === "Escape") { e.preventDefault(); cancelEditSubtask(); }
                              }}
                              className="flex-1 text-[14px] px-2 py-1 rounded-[8px] outline-none"
                              style={{ background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                            />
                          ) : (
                            <span onClick={() => startEditSubtask(subtask)} className="flex-1 text-[14px] cursor-text"
                              style={{ color: subtask.status === "completed" ? "var(--strike)" : "var(--ink2)", textDecoration: subtask.status === "completed" ? "line-through" : undefined }}>
                              {subtask.title}
                              {subtask.linkedParentId && (
                                <span className="ml-2 text-[10px] px-[6px] py-px rounded-[5px] align-middle" style={{ color: "var(--accent)", background: "var(--chip)" }}>linked</span>
                              )}
                            </span>
                          )}
                          {editingSubtaskId !== subtask._id && !subtask.linkedParentId && (
                            <button onClick={() => startEditSubtask(subtask)} aria-label="Edit subtask"
                              className="p-1 rounded shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--hover)]" style={{ color: "var(--muted2)" }}>
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {subtask.linkedParentId ? (
                            <button onClick={() => void handleUnlinkSubtask(subtask)} title="Unlink (keeps the task in its quadrant)"
                              className="p-1 rounded shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--hover)]" style={{ color: "var(--muted2)" }}>
                              <Unlink className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button onClick={() => handleDeleteSubtask(subtask._id)}
                              className="p-1 rounded shrink-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[var(--tag-bg)]" style={{ color: "var(--tag-fg)" }}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* add subtask */}
                  <div className="hovrow flex items-center gap-2.5 mt-2 rounded-[10px]" style={{ padding: "9px 11px", border: "1px dashed var(--dash)" }}>
                    <span className="block w-[17px] h-[17px] rounded-full shrink-0" style={{ border: "1.5px dashed var(--check-bd)" }} />
                    <input
                      type="text"
                      placeholder="Add a subtask…"
                      value={newSubtaskTitle}
                      onChange={(e) => setNewSubtaskTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && newSubtaskTitle.trim()) { e.preventDefault(); void handleAddSubtask(); } }}
                      className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-[color:var(--muted3)]"
                      style={{ color: "var(--ink)" }}
                    />
                    <button onClick={() => void handleAddSubtask()} disabled={!newSubtaskTitle.trim()}
                      className="shrink-0 w-[26px] h-[26px] rounded-[8px] flex items-center justify-center disabled:opacity-40"
                      style={{ background: "var(--chip)", color: "var(--ink3)" }}>
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {/* checklists — reusable procedures copied in from the library */}
              {editingTask && !editingTask.parentTaskId && (
                <div className="mt-5 pt-5" style={{ borderTop: "1px solid var(--line2)" }}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-[11px] tracking-[0.14em] uppercase" style={{ color: "var(--muted5)" }}>Checklists</span>
                    <button onClick={() => openChecklistLibrary()} className="text-[11.5px]" style={{ color: "var(--accent)" }}>Library ›</button>
                  </div>
                  <div className="text-[12px] mb-3.5" style={{ color: "var(--muted3)" }}>
                    Saved procedures you run again on every job. Ticking is for your own tracking.
                  </div>

                  {[...(editingTask.checklists ?? [])].sort((a, b) => a.order - b.order).map((checklist) => {
                    // Counts cover required steps; optional ones are shown separately and never block.
                    const progress = stepProgress(checklist.steps);
                    const onlyOptional = progress.total === 0 && progress.optionalTotal > 0;
                    const countLabel = onlyOptional
                      ? `${progress.optionalDone}/${progress.optionalTotal}`
                      : `${progress.done}/${progress.total}`;
                    const countTitle = onlyOptional
                      ? `${progress.optionalDone} of ${progress.optionalTotal} optional steps done`
                      : `${progress.done} of ${progress.total} required steps done` +
                        (progress.optionalTotal ? `, plus ${progress.optionalTotal} optional (${progress.optionalDone} done)` : "");
                    const open = expandedTaskChecklistIds.has(checklist.id);
                    // Blank rows count for nothing and only show as empty lines, so they're hidden.
                    const shown = open ? checklist.steps.filter(s => !isBlankStep(s) || s.id.startsWith("tmp-")) : [];
                    return (
                      <div key={checklist.id} className="group rounded-[13px] overflow-hidden mb-2.5"
                        style={{ background: "var(--surface)", border: "1px solid var(--surface-bd)" }}>
                        <div className="flex items-center gap-2.5 cursor-pointer" style={{ padding: "13px 15px" }}
                          onClick={() => setExpandedTaskChecklistIds(prev => {
                            const next = new Set(prev);
                            if (next.has(checklist.id)) next.delete(checklist.id); else next.add(checklist.id);
                            return next;
                          })}>
                          <span className="text-[10px] w-[10px] shrink-0" style={{ color: "var(--muted2)" }}>{open ? "▾" : "›"}</span>
                          <span className="flex-1 min-w-0 truncate text-[14px] font-medium" style={{ color: "var(--ink)" }}>{checklist.name}</span>
                          <span className="flex items-center gap-2 shrink-0">
                            <span className="w-[52px] h-[5px] rounded-full overflow-hidden" style={{ background: "var(--line3)" }}>
                              <span className="block h-full" style={{ width: `${progress.percent}%`, background: "var(--pill-active)" }} />
                            </span>
                            <span className="text-[11.5px] whitespace-nowrap" title={countTitle} aria-label={countTitle}
                              style={{ color: progress.complete ? "var(--accent)" : "var(--muted)" }}>
                              {countLabel}
                              {(progress.optionalTotal > 0) && (
                                <span style={{ color: "var(--muted3)" }}>
                                  {onlyOptional ? " optional" : ` +${progress.optionalTotal} optional`}
                                </span>
                              )}
                            </span>
                          </span>
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger asChild>
                              <button onClick={(e) => e.stopPropagation()}
                                className="shrink-0 px-1 rounded text-[14px] outline-none"
                                style={{ color: "var(--muted2)" }}>⋮</button>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CLS}>
                                <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void handleResetChecklist(editingTask._id, checklist.id)}>
                                  Reset all steps
                                </DropdownMenu.Item>
                                {checklist.sourceId && (
                                  <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void handlePushChecklistToTemplate(editingTask._id, checklist.id)}>
                                    Save changes to checklist
                                  </DropdownMenu.Item>
                                )}
                                <DropdownMenu.Separator className="h-px my-1" style={{ background: "var(--line3)" }} />
                                <DropdownMenu.Item className={MENU_ITEM} style={{ color: "var(--tag-fg)" }}
                                  onSelect={() => void handleDetachChecklist(editingTask._id, checklist.id)}>
                                  Detach
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu.Root>
                        </div>

                        {open && (
                          <div style={{ padding: "2px 15px 6px", borderTop: "1px solid var(--line2)" }}>
                            <div className="flex flex-col">
                              {shown.map((step) => (
                                <div key={step.id} className="hovrow group/step flex items-start gap-2.5 rounded-[8px]" style={{ padding: "8px", margin: "0 -8px" }}>
                                  <span className={cn("qcheck", step.done && "checked", step.optional && "optional")}
                                    style={{ marginTop: 3 }}
                                    role="checkbox" aria-checked={step.done}
                                    aria-label={`${step.text}${step.optional ? " (optional)" : ""}`}
                                    onClick={() => handleToggleChecklistStep(editingTask._id, checklist, step.id)} />
                                  <div className="flex-1 min-w-0">
                                    <span className="text-[13.5px]"
                                      style={{ color: step.done ? "var(--strike)" : "var(--ink2)", textDecoration: step.done ? "line-through" : undefined }}>
                                      {step.text}
                                    </span>
                                    {step.optional && (
                                      <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-[0.08em] rounded-full whitespace-nowrap"
                                        style={{ padding: "1px 7px", border: "1px dashed var(--check-bd)", color: "var(--muted)" }}>
                                        Optional
                                      </span>
                                    )}
                                    {step.note?.trim() && (
                                      <div className="text-[12px] mt-0.5 whitespace-pre-wrap break-words" style={{ color: "var(--muted)" }}>
                                        <LinkifiedText text={step.note} linkStyle={{ color: "var(--accent)" }} />
                                      </div>
                                    )}
                                  </div>
                                  <button onClick={() => void handleToggleStepOptional(editingTask._id, checklist.id, step.id)}
                                    className="shrink-0 p-0.5 rounded opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100 transition-opacity"
                                    style={{ color: "var(--muted2)" }}
                                    title={step.optional ? "Make required" : "Make optional (won't block the task)"}
                                    aria-label={step.optional ? `Make "${step.text}" required` : `Make "${step.text}" optional`}>
                                    {step.optional ? <CircleDot className="w-[13px] h-[13px]" /> : <CircleDashed className="w-[13px] h-[13px]" />}
                                  </button>
                                  <button onClick={() => void handleRemoveChecklistStep(editingTask._id, checklist.id, step.id)}
                                    className="shrink-0 p-0.5 rounded opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100 transition-opacity"
                                    style={{ color: "var(--muted2)" }} title="Remove step" aria-label={`Remove "${step.text}"`}>
                                    <Trash2 className="w-[13px] h-[13px]" />
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div className="flex items-center gap-2.5 mt-1.5 mb-1">
                              <input
                                type="text"
                                placeholder="Add step…"
                                value={newChecklistStep[checklist.id] ?? ""}
                                onChange={(e) => setNewChecklistStep(prev => ({ ...prev, [checklist.id]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void handleAddChecklistStep(editingTask._id, checklist.id, newChecklistStep[checklist.id] ?? "");
                                  }
                                }}
                                className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-[color:var(--muted3)]"
                                style={{ color: "var(--ink)" }}
                              />
                              <button onClick={() => void handleAddChecklistStep(editingTask._id, checklist.id, newChecklistStep[checklist.id] ?? "")}
                                disabled={!(newChecklistStep[checklist.id] ?? "").trim()}
                                className="shrink-0 text-[12.5px] font-semibold disabled:opacity-40"
                                style={{ color: "var(--accent)" }}>
                                + Add step
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <button
                    onClick={() => { setAttachPickerOpen(true); setAttachSearch(""); void fetchMyndlistTemplates(); }}
                    className="hovrow w-full text-[13px] rounded-[11px]"
                    style={{ padding: "11px", textAlign: "center", border: "1px dashed var(--check-bd)", color: "var(--muted5)" }}>
                    + Attach a checklist
                  </button>
                </div>
              )}
            </div>

            {/* footer */}
            <div className="flex items-center justify-between gap-3 shrink-0" style={{ padding: "13px 22px", borderTop: "1px solid var(--line2)", background: "var(--form-bg)" }}>
              {editingTask ? (
                <button onClick={() => void handleDeleteTask(editingTask)} className="text-[13px] font-medium px-1" style={{ color: "var(--tag-fg)" }}>
                  Delete
                </button>
              ) : <span />}
              <div className="flex items-center gap-2">
                <button onClick={closeModal} className="text-[13px] rounded-[10px]"
                  style={{ padding: "9px 18px", border: "1px solid var(--field-bd)", color: "var(--ink2)" }}>
                  Cancel
                </button>
                <button
                  onClick={editingTask ? handleUpdateTask : handleAddTask}
                  disabled={!formData.title || (taskOperationLoading.addTask ?? taskOperationLoading.updateTask)}
                  className="cta text-[13px] font-semibold rounded-[10px] disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ padding: "9px 22px", background: "var(--btn-primary)", color: "var(--btn-fg)" }}>
                  {(taskOperationLoading.addTask ?? taskOperationLoading.updateTask) ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Attach a checklist — sits ABOVE the task modal, which stays mounted so
          dismissing returns to it rather than closing everything. Rendered as a
          sibling because the modal card is overflow-hidden and would clip it. */}
      {attachPickerOpen && editingTask && (
        <>
          <div onClick={() => setAttachPickerOpen(false)} className="fixed inset-0 z-[64]"
            style={{ background: "rgba(0,0,0,0.18)", animation: "fadeIn .15s ease" }} />
          <div className="fixed left-1/2 -translate-x-1/2 top-[14vh] z-[65] w-[520px] max-w-[92vw] rounded-[16px] overflow-hidden"
            style={{ background: "var(--drawer)", border: "1px solid var(--drawer-bd)", boxShadow: "0 30px 70px -30px rgba(70,55,30,0.5)" }}>
            <div className="flex items-center gap-3" style={{ padding: "15px 19px", borderBottom: "1px solid var(--line2)" }}>
              <Search className="w-[15px] h-[15px] shrink-0" style={{ color: "var(--muted)" }} />
              <input
                autoFocus
                value={attachSearch}
                onChange={(e) => setAttachSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setAttachPickerOpen(false); } }}
                placeholder="Search your checklists…"
                className="flex-1 bg-transparent text-[15px] outline-none placeholder:text-[color:var(--muted3)]"
                style={{ color: "var(--ink)" }}
              />
              <button onClick={() => setAttachPickerOpen(false)} className="text-[11px] rounded-[6px] shrink-0"
                style={{ padding: "3px 8px", background: "var(--chip)", color: "var(--muted)" }}>esc</button>
            </div>

            <div style={{ padding: "10px 12px 12px" }} className="max-h-[46vh] overflow-y-auto">
              {!myndlistConfigured ? (
                <div className="px-3 py-5 text-[13px] text-center leading-[1.55]" style={{ color: "var(--muted)" }}>
                  Connect Myndlist in Settings → Integrations to reuse your checklists here.
                </div>
              ) : (
                (() => {
                  const q = attachSearch.trim().toLowerCase();
                  const matches = [...myndlistTemplates]
                    .filter(t => !q || t.name.toLowerCase().includes(q))
                    .sort((a, b) => b.usageCount - a.usageCount);
                  return (
                    <>
                      {myndlistLoading && matches.length === 0 && (
                        <div className="flex flex-col gap-1.5">{[0, 1].map(i => <div key={i} className="skel h-[40px] rounded-[10px]" />)}</div>
                      )}
                      {matches.length > 0 && (
                        <>
                          <div className="text-[10px] uppercase tracking-[0.12em]" style={{ padding: "6px 10px 8px", color: "var(--muted4)" }}>Your checklists</div>
                          {matches.map((template) => {
                            const at = q ? template.name.toLowerCase().indexOf(q) : -1;
                            return (
                              <button key={template.id} disabled={attachBusyId !== null}
                                onClick={() => void handleAttachChecklist(editingTask._id, template.id)}
                                className="hovrow w-full flex items-center gap-3 rounded-[10px] text-left disabled:opacity-50"
                                style={{ padding: "11px 12px" }}>
                                <span className="flex-1 min-w-0 truncate text-[14px]" style={{ color: "var(--ink)" }}>
                                  {at >= 0 ? (
                                    <>
                                      {template.name.slice(0, at)}
                                      <span style={{ background: "var(--chip)", borderRadius: 3, padding: "0 3px" }}>{template.name.slice(at, at + q.length)}</span>
                                      {template.name.slice(at + q.length)}
                                    </>
                                  ) : template.name}
                                </span>
                                <span className="text-[11.5px] shrink-0" style={{ color: "var(--muted)" }}>
                                  {templateStepSummary(template)} · used {template.usageCount}×
                                </span>
                              </button>
                            );
                          })}
                        </>
                      )}
                      {!myndlistLoading && matches.length === 0 && (
                        <div className="px-3 py-4 text-[13px] text-center" style={{ color: "var(--muted)" }}>
                          {myndlistTemplates.length === 0 ? "No checklists yet." : `Nothing matching “${attachSearch}”.`}
                        </div>
                      )}
                      {/* Works from an empty query too: the first thing every user
                          sees here is an empty library, and this is the way out. */}
                      <div className="h-px" style={{ background: "var(--line2)", margin: "9px 12px" }} />
                      <button
                        disabled={templateSaving || attachBusyId !== null}
                        onClick={async () => {
                          const name = attachSearch.trim() || "Untitled checklist";
                          const created = await handleCreateTemplate(name);
                          if (created) await handleAttachChecklist(editingTask._id, created.id);
                        }}
                        className="hovrow w-full flex items-center gap-2.5 rounded-[10px] text-left text-[13.5px] font-semibold disabled:opacity-50"
                        style={{ padding: "10px 12px", color: "var(--accent)" }}>
                        {attachSearch.trim() ? `+ Create “${attachSearch.trim()}” as a new checklist` : "+ Create a new checklist"}
                      </button>
                    </>
                  );
                })()
              )}
            </div>
          </div>
        </>
      )}

      {/* Settings Modal */}
      <Dialog.Root open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40" style={{ background: "var(--overlay)" }} />
          <Dialog.Content
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-[680px] max-h-[86vh] flex flex-col rounded-[18px] overflow-hidden"
            style={{ background: "var(--drawer)", border: "1px solid var(--drawer-bd)", boxShadow: "0 30px 70px -30px rgba(70,55,30,0.5)", color: "var(--ink)" }}
          >
            <div className="shrink-0 flex items-center justify-between" style={{ padding: "18px 24px", borderBottom: "1px solid var(--line2)" }}>
              <Dialog.Title style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[22px]">Settings</Dialog.Title>
              <Dialog.Close asChild>
                <button className="p-1 text-[20px]" style={{ color: "var(--muted)" }}>✕</button>
              </Dialog.Close>
            </div>

            <Dialog.Description className="sr-only">Application settings</Dialog.Description>

            {/* nav + pane. Only the pane scrolls, so the footer never leaves. */}
            <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
              <nav className="shrink-0 sm:w-[168px] flex sm:flex-col gap-1 overflow-x-auto p-2.5 border-b sm:border-b-0 sm:border-r border-[var(--line2)]">
                {SETTINGS_SECTIONS.map((sec) => {
                  const active = settingsSection === sec.id;
                  return (
                    <button key={sec.id} onClick={() => setSettingsSection(sec.id)}
                      className="shrink-0 text-left text-[13px] rounded-[9px] transition-colors whitespace-nowrap"
                      style={{ padding: "8px 12px", fontWeight: active ? 600 : 400, color: active ? "var(--ink)" : "var(--muted5)", background: active ? "var(--chip)" : "transparent" }}>
                      {sec.label}
                    </button>
                  );
                })}
              </nav>

              <div className="flex-1 min-h-0 overflow-y-auto" style={{ padding: "20px 24px" }}>
              {settingsSection === "tasks" && (
              <div>
                <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>Completed tasks</label>
                <p className="text-[12px] mb-2.5" style={{ color: "var(--muted)" }}>
                  Completed tasks stay on the board, crossed off at the bottom of their quadrant, until you archive them.
                </p>

                <button onClick={() => setDraftAutoArchive(v => !v)}
                  className="w-full flex items-center justify-between gap-3 rounded-[10px] text-left"
                  style={{ padding: "10px 12px", background: "var(--field)", border: "1px solid var(--field-bd)" }}>
                  <span className="text-[13px]" style={{ color: "var(--ink2)" }}>Archive automatically when completed</span>
                  <span className="shrink-0 rounded-full transition-colors" style={{ width: 36, height: 20, padding: 2, background: draftAutoArchive ? "var(--pill-active)" : "var(--check-bd)" }}>
                    <span className="block rounded-full transition-transform" style={{ width: 16, height: 16, background: "var(--btn-fg)", transform: draftAutoArchive ? "translateX(16px)" : "translateX(0)" }} />
                  </span>
                </button>

                <div className="flex items-center justify-between gap-3 mt-2.5">
                  <span className="text-[12.5px]" style={{ color: "var(--muted5)" }}>
                    {archivedTasks.length === 0
                      ? "No archived tasks."
                      : `${archivedTasks.length} archived task${archivedTasks.length === 1 ? "" : "s"}.`}
                  </span>
                  {archivedTasks.length > 0 && (
                    <button
                      onClick={() => { if (confirm(`Permanently delete ${archivedTasks.length} archived task${archivedTasks.length === 1 ? "" : "s"}? This cannot be undone.`)) void handleDeleteArchivedTasks(); }}
                      className="text-[12.5px] font-semibold" style={{ color: "var(--tag-fg)" }}>
                      Delete all
                    </button>
                  )}
                </div>

                {archivedTasks.length > 0 && (
                  <div className="mt-2 rounded-[10px] overflow-hidden" style={{ border: "1px solid var(--field-bd)" }}>
                    <div className="max-h-[168px] overflow-y-auto">
                      {archivedTasks.map((t) => (
                        <div key={t._id} className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid var(--line2)" }}>
                          <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: MATRIX_META[t.quadrant].color }} />
                          <span className="flex-1 text-[13px] truncate" style={{ color: "var(--ink3)", textDecoration: t.status === "completed" ? "line-through" : undefined }}>{t.title}</span>
                          <button onClick={() => void handleRestoreTask(t)} className="text-[12px] shrink-0" style={{ color: "var(--accent)" }}>Restore</button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              )}

              {settingsSection === "greeting" && (
              <div>
              {/* Weather location */}
              <div className="pb-5">
                <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>Weather location</label>
                <p className="text-[12px] mb-2" style={{ color: "var(--muted)" }}>Drives the weather and what-to-wear line in your greeting.</p>
                <input
                  type="text"
                  value={locationInput}
                  onChange={(e) => setLocationInput(e.target.value)}
                  placeholder="Montreal, Quebec"
                  className="w-full text-[13.5px] rounded-[10px] outline-none"
                  style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                />
              </div>

              {/* Gemini API Key */}
              <div>
                <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>Google Gemini API key</label>
                <p className="text-[12px] mb-2" style={{ color: "var(--muted)" }}>
                  Used for AI what-to-wear suggestions. Get a free key at{" "}
                  <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }} className="hover:underline">aistudio.google.com</a>
                </p>
                <input
                  type="password"
                  value={settingsKeyInput}
                  onChange={(e) => setSettingsKeyInput(e.target.value)}
                  placeholder="AIza..."
                  className="w-full text-[13.5px] rounded-[10px] outline-none"
                  style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                />
                {settingsKeyInput && (
                  <button
                    onClick={() => setSettingsKeyInput("")}
                    className="text-[12px] font-medium mt-2"
                    style={{ color: "var(--tag-fg)" }}
                  >
                    Remove key
                  </button>
                )}
              </div>

              {/* Anthropic (Claude) API Key */}
              <div className="pt-5">
                <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>Claude API key</label>
                <p className="text-[12px] mb-2" style={{ color: "var(--muted)" }}>
                  Used by the AI assistant to suggest how to prioritize your tasks (experimental). Create a key at{" "}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }} className="hover:underline">console.anthropic.com</a>
                </p>
                <input
                  type="password"
                  value={draftAnthropicKey}
                  onChange={(e) => setDraftAnthropicKey(e.target.value)}
                  placeholder="sk-ant-..."
                  autoComplete="off"
                  className="w-full text-[13.5px] rounded-[10px] outline-none"
                  style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                />
                {draftAnthropicKey && (
                  <button
                    onClick={() => setDraftAnthropicKey("")}
                    className="text-[12px] font-medium mt-2"
                    style={{ color: "var(--tag-fg)" }}
                  >
                    Remove key
                  </button>
                )}
              </div>

              </div>
              )}

              {settingsSection === "calendar" && (
              <div>
                <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>Calendar feeds (iCal)</label>
                <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
                  Add .ics feed URLs from Google, Apple, or Outlook. Today&apos;s events appear next to your routine. For Google, use the <strong>Secret address in iCal format</strong> — not the public URL.
                </p>
                {draftIcalUrls.length > 0 && (
                  <div className="flex flex-col gap-1.5 mb-3">
                    {draftIcalUrls.map((url, i) => (
                      <div key={i} className="flex items-center gap-2 text-[12px] rounded-[10px]" style={{ padding: "9px 12px", background: "var(--tint)" }}>
                        <Calendar className="w-3.5 h-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                        <span className="flex-1 truncate font-mono" style={{ color: "var(--ink3)" }}>{url}</span>
                        <button
                          onClick={() => setDraftIcalUrls(draftIcalUrls.filter((_, j) => j !== i))}
                          className="shrink-0 p-1 rounded" style={{ color: "var(--tag-fg)" }}
                          aria-label="Remove calendar feed"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={settingsIcalInput}
                      onChange={(e) => { setSettingsIcalInput(e.target.value); setSettingsIcalError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") addDraftIcalUrl(); }}
                      placeholder="https://calendar.google.com/...ical/..."
                      className="flex-1 text-[13.5px] rounded-[10px] outline-none"
                      style={{ padding: "10px 14px", background: "var(--field)", border: `1px solid ${settingsIcalError ? "var(--tag-fg)" : "var(--field-bd)"}`, color: "var(--ink)" }}
                    />
                    <button
                      onClick={addDraftIcalUrl}
                      disabled={!settingsIcalInput.trim()}
                      className="cta text-[13px] font-semibold rounded-[10px] disabled:opacity-40" style={{ padding: "9px 20px", color: "var(--btn-fg)", background: "var(--btn-primary)" }}
                    >
                      Add
                    </button>
                  </div>
                  {settingsIcalError && <p className="text-[12px]" style={{ color: "var(--tag-fg)" }}>{settingsIcalError}</p>}
                </div>
              </div>
              )}

              {settingsSection === "integrations" && (
              <div>
                <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>CashFold API integration</label>
                <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
                  Connect your CashFold account to show what&apos;s due today and where the day ends, above the Priority Matrix. Your endpoint and key are encrypted and used only for your own dashboard.
                </p>

                <label className="block text-[12px] mb-1.5" style={{ color: "var(--ink3)" }}>API endpoint</label>
                <input
                  type="text"
                  value={draftFinanceUrl}
                  onChange={(e) => { setDraftFinanceUrl(e.target.value); setFinanceTestResult(null); }}
                  placeholder="https://api.cashfold.com/v1/day/{date}"
                  className="w-full text-[13px] rounded-[10px] outline-none mb-1.5 font-mono"
                  style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                />
                <p className="text-[11.5px] mb-4" style={{ color: "var(--muted)" }}>
                  Use <strong>{"{date}"}</strong> where the day should go. Without it, <code>?date=YYYY-MM-DD</code> is appended.
                </p>

                <label className="block text-[12px] mb-1.5" style={{ color: "var(--ink3)" }}>CashFold user ID</label>
                <input
                  type="text"
                  value={draftFinanceUserId}
                  onChange={(e) => { setDraftFinanceUserId(e.target.value); setFinanceTestResult(null); }}
                  placeholder="df29c04e-9afb-4267-bc55-69822cb80229"
                  className="w-full text-[13px] rounded-[10px] outline-none mb-1.5 font-mono"
                  style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                />
                <p className="text-[11.5px] mb-4" style={{ color: "var(--muted)" }}>
                  Sent as <code>?userId=</code>. Overrides any userId already in the endpoint above.
                </p>

                <label className="block text-[12px] mb-1.5" style={{ color: "var(--ink3)" }}>API key</label>
                <input
                  type="password"
                  value={draftFinanceKey}
                  onChange={(e) => { setDraftFinanceKey(e.target.value); setFinanceTestResult(null); }}
                  placeholder="Sent as the X-API-Key header"
                  className="w-full text-[13px] rounded-[10px] outline-none"
                  style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                />

                <div className="flex items-center justify-between gap-3 mt-3">
                  <span className="text-[12px]" style={{ color: financeApiUrl ? "var(--accent)" : "var(--muted)" }}>
                    {financeApiUrl ? "Connected" : "Not connected"}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => void handleTestFinanceConnection()}
                      disabled={financeTesting || !draftFinanceUrl.trim()}
                      className="text-[12.5px] font-medium rounded-[9px] disabled:opacity-40"
                      style={{ padding: "7px 14px", background: "var(--chip)", color: "var(--ink2)" }}
                    >
                      {financeTesting ? "Testing…" : "Test connection"}
                    </button>
                    {(draftFinanceUrl || draftFinanceKey || draftFinanceUserId) && (
                      <button onClick={() => { setDraftFinanceUrl(""); setDraftFinanceKey(""); setDraftFinanceUserId(""); setFinanceTestResult(null); }}
                        className="text-[12.5px] font-semibold" style={{ color: "var(--tag-fg)" }}>
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>

                {financeTestResult && (
                  <p
                    className="text-[12px] rounded-[10px] mt-3"
                    style={{
                      padding: "10px 12px",
                      background: "var(--form-bg)",
                      border: `1px solid ${financeTestResult.ok ? "var(--field-bd)" : "var(--tag-fg)"}`,
                      color: financeTestResult.ok ? "var(--accent)" : "var(--tag-fg)",
                    }}
                  >
                    {financeTestResult.message}
                  </p>
                )}

                <p className="text-[11.5px] mt-3" style={{ color: "var(--muted)" }}>
                  Test connection uses what&apos;s in the fields above, so you can check a key before saving it.
                </p>

                <div className="mt-6 pt-6" style={{ borderTop: "1px solid var(--line2)" }}>
                  <label className="block text-[13px] font-semibold mb-1.5" style={{ color: "var(--ink2)" }}>Myndlist checklists</label>
                  <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>
                    Connect Myndlist to reuse its checklists here. Attaching one to a task copies its steps in fresh, so ticking them never changes the original.
                  </p>

                  <label className="block text-[12px] mb-1.5" style={{ color: "var(--ink3)" }}>Myndlist URL</label>
                  <input
                    type="text"
                    value={draftMyndlistUrl}
                    onChange={(e) => { setDraftMyndlistUrl(e.target.value); setMyndlistTestResult(null); }}
                    placeholder="https://your-myndlist.vercel.app"
                    className="w-full text-[13px] rounded-[10px] outline-none mb-1.5 font-mono"
                    style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                  />
                  <p className="text-[11.5px] mb-4" style={{ color: "var(--muted)" }}>
                    The site address. <code>/api/v1</code> is added for you. A Myndlist on localhost can&apos;t be reached from here.
                  </p>

                  <label className="block text-[12px] mb-1.5" style={{ color: "var(--ink3)" }}>API key</label>
                  <input
                    type="password"
                    value={draftMyndlistKey}
                    onChange={(e) => { setDraftMyndlistKey(e.target.value); setMyndlistTestResult(null); }}
                    placeholder="mynd_…"
                    className="w-full text-[13px] rounded-[10px] outline-none"
                    style={{ padding: "10px 14px", background: "var(--field)", border: "1px solid var(--field-bd)", color: "var(--ink)" }}
                  />
                  <p className="text-[11.5px] mt-1.5" style={{ color: "var(--muted)" }}>
                    Create one in Myndlist under <strong>API keys</strong>. It is shown only once.
                  </p>

                  <div className="flex items-center justify-between gap-3 mt-3">
                    <span className="text-[12px]" style={{ color: myndlistApiUrl ? "var(--accent)" : "var(--muted)" }}>
                      {myndlistApiUrl ? "Connected" : "Not connected"}
                    </span>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => void handleTestMyndlistConnection()}
                        disabled={myndlistTesting || !draftMyndlistUrl.trim()}
                        className="text-[12.5px] font-medium rounded-[9px] disabled:opacity-40"
                        style={{ padding: "7px 14px", background: "var(--chip)", color: "var(--ink2)" }}
                      >
                        {myndlistTesting ? "Testing…" : "Test connection"}
                      </button>
                      {(draftMyndlistUrl || draftMyndlistKey) && (
                        <button onClick={() => { setDraftMyndlistUrl(""); setDraftMyndlistKey(""); setMyndlistTestResult(null); }}
                          className="text-[12.5px] font-semibold" style={{ color: "var(--tag-fg)" }}>
                          Disconnect
                        </button>
                      )}
                    </div>
                  </div>

                  {myndlistTestResult && (
                    <p
                      className="text-[12px] rounded-[10px] mt-3"
                      style={{
                        padding: "10px 12px",
                        background: "var(--form-bg)",
                        border: `1px solid ${myndlistTestResult.ok ? "var(--field-bd)" : "var(--tag-fg)"}`,
                        color: myndlistTestResult.ok ? "var(--accent)" : "var(--tag-fg)",
                      }}
                    >
                      {myndlistTestResult.message}
                    </p>
                  )}
                </div>
              </div>
              )}
              </div>
            </div>

            {/* Footer sits outside the scroll area, so Save is always reachable */}
            <div className="shrink-0 flex items-center justify-between gap-3" style={{ padding: "14px 24px", borderTop: "1px solid var(--line2)", background: "var(--form-bg)" }}>
              <span className="text-[12px]" style={{ color: settingsDirty ? "var(--accent)" : "transparent" }}>
                Unsaved changes
              </span>
              <div className="flex items-center gap-2.5">
              <Dialog.Close asChild>
                <button className="text-[13px] font-medium rounded-[10px]" style={{ padding: "9px 18px", color: "var(--ink2)", background: "var(--chip)" }}>
                  Cancel
                </button>
              </Dialog.Close>
              <button
                onClick={handleSaveSettings}
                disabled={!settingsDirty}
                className="cta text-[13px] font-semibold rounded-[10px] disabled:opacity-40"
                style={{ padding: "9px 22px", color: "var(--btn-fg)", background: "var(--btn-primary)" }}
              >
                Save changes
              </button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Eisenhower Matrix Info Modal */}
      {isInfoModalOpen && (
        <>
          <div onClick={() => setIsInfoModalOpen(false)} className="fixed inset-0 z-50" style={{ background: "var(--overlay)", animation: "fadeIn .2s ease" }} />
          <div className="fixed inset-0 z-[51] flex items-center justify-center p-4">
            <div className="w-full max-w-[600px] max-h-[90vh] overflow-y-auto rounded-[18px]"
              style={{ background: "var(--drawer)", border: "1px solid var(--drawer-bd)", boxShadow: "0 30px 70px -30px rgba(70,55,30,0.5)", padding: "26px 28px", animation: "fadeIn .2s ease" }}>
              <div className="flex items-center justify-between mb-4">
                <div style={{ fontFamily: "var(--font-serif)", color: "var(--ink)" }} className="text-[24px]">The Eisenhower Matrix</div>
                <button onClick={() => setIsInfoModalOpen(false)} className="p-1 text-[20px]" style={{ color: "var(--muted)" }}>✕</button>
              </div>
              <p className="text-[14px] mb-5" style={{ color: "var(--ink4)" }}>
                Prioritize by urgency and importance — decide what to do first, what to schedule, what to hand off, and what to let go.
              </p>
              <div className="flex flex-col gap-3">
                {[
                  { c: "var(--q-do-first)", t: "Urgent & Important — Do First", d: "Crises, deadlines, and problems that need action now. Handle these right away — they can't wait." },
                  { c: "var(--q-schedule)", t: "Important & Not Urgent — Schedule", d: "Crucial for long-term success but no pressing deadline. Give these dedicated time — often neglected, most valuable." },
                  { c: "var(--q-delegate)", t: "Urgent & Not Important — Delegate", d: "Demand attention but don't move your goals. Delegate when possible, or minimize the time you spend." },
                  { c: "var(--q-eliminate)", t: "Not Urgent & Not Important — Eliminate", d: "Time-wasters and busywork. Drop these or dramatically reduce them." },
                ].map((q) => (
                  <div key={q.t} className="rounded-[12px]" style={{ background: "var(--tint)", borderLeft: `3px solid ${q.c}`, padding: "14px 16px" }}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="w-[9px] h-[9px] rounded-full" style={{ background: q.c }} />
                      <span className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>{q.t}</span>
                    </div>
                    <p className="text-[13px]" style={{ color: "var(--ink4)" }}>{q.d}</p>
                  </div>
                ))}
              </div>
              <div className="rounded-[12px] mt-4" style={{ background: "var(--chip)", padding: "14px 16px" }}>
                <p className="text-[13px]" style={{ color: "var(--ink4)" }}>
                  <strong style={{ color: "var(--ink2)" }}>Pro tip:</strong> Spend most of your energy in <em>Schedule</em>. Those tasks drive long-term success and prevent crises before they start.
                </p>
              </div>
              <div className="mt-5 flex justify-end">
                <button onClick={() => setIsInfoModalOpen(false)} className="cta text-[13px] font-semibold rounded-[10px]" style={{ padding: "9px 22px", color: "var(--btn-fg)", background: "var(--btn-primary)" }}>Got it</button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Footer */}
      <footer className={cn(
        "border-t py-6 mt-8",
        isDarkMode ? "border-gray-800 bg-gray-900/50" : "border-gray-200 bg-white/50"
      )}>
        <div className="px-4 md:px-6">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <p className={cn("text-sm", isDarkMode ? "text-gray-400" : "text-gray-500")}>
              {new Date().getFullYear()} All rights reserved.
            </p>
            <div className="flex items-center gap-2">
              <span className={cn("text-sm", isDarkMode ? "text-gray-400" : "text-gray-500")}>
                Created by
              </span>
              <a
                href="https://www.lumeve.ca/"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "text-sm font-medium transition-colors",
                  darkMode
                    ? "text-[var(--accent)] hover:text-blue-300"
                    : "text-[var(--accent)] hover:brightness-95"
                )}
              >
                Lumeve
              </a>
            </div>
          </div>
        </div>
      </footer>

      {/* Toast Notifications */}
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: isDarkMode ? '#1f2937' : '#fff',
            color: isDarkMode ? '#fff' : '#111827',
            border: isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb',
          },
          success: {
            iconTheme: {
              primary: '#10b981',
              secondary: isDarkMode ? '#1f2937' : '#fff',
            },
          },
          error: {
            iconTheme: {
              primary: '#ef4444',
              secondary: isDarkMode ? '#1f2937' : '#fff',
            },
          },
        }}
      />
    </div>
  );
}