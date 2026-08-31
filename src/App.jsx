import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";
import {
  LayoutGrid, BookOpen, CalendarDays, Timer, HelpCircle, Star, AlertTriangle,
  Inbox, ClipboardList, Library, BarChart3, CalendarCheck, Settings, Search,
  Plus, X, ChevronRight, Menu, Circle, Play, Pause, Square,
} from "lucide-react";

/* Browser persistence shim — must run before any component mounts.
   Claude artifacts provide window.storage; static hosts (Vercel) do not.
   Installing here (not only in main.jsx) avoids race if entry order differs. */
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key, _secure) {
      try {
        const value = localStorage.getItem(String(key));
        if (value == null) return null;
        return { value, key: String(key) };
      } catch {
        return null;
      }
    },
    async set(key, value, _secure) {
      try {
        localStorage.setItem(String(key), String(value));
      } catch { /* quota / private mode */ }
    },
  };
}

/* ============================================================
   FOUNDATION
   NEET Preparation OS — app shell, data models, persistence.
   Prep start date: 25 August 2026.

   Zero stored data renders as zero — no fabricated activity.
   ============================================================ */

const PREP_START_DATE = "2026-08-25";

/* ------------------------------------------------------------
   TYPE SHAPES (documented — this is a plain-JS artifact, so
   these are the TypeScript interfaces expressed as factories +
   comments rather than compiled types).
   ------------------------------------------------------------ */

// Task
// { id, title, description, subject, subjectId, chapterId, topicId,
//   topic, type, priority, status, date, deadline, startTime, endTime,
//   estimatedMinutes, actualMinutes, testId, createdAt, completedAt, notes }
const TASK_TYPES = ["LECTURE", "QUESTIONS", "REVISION", "PYQ", "NCERT", "NOTES", "TEST", "TEST_ANALYSIS", "DOUBT", "BACKLOG", "OTHER"];
// Eligible to trigger the automatic chapter-revision chain when explicitly flagged.
const FIRST_STUDY_ELIGIBLE_TYPES = ["LECTURE", "QUESTIONS", "PYQ", "NCERT", "NOTES"];
const TASK_PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const TASK_STATUSES = ["TODO", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

function safeNumber(v, fallback = 0) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Downscales + re-encodes an uploaded image client-side before it's stored
// as a data URL on the Question record — keeps persisted storage size
// reasonable since the whole `questions` array lives under one storage key.
function compressImageFile(file, maxWidth = 900, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Could not read image"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function makeTask(partial) {
  const now = new Date().toISOString();
  return {
    id: partial.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: "", description: "", subject: "", subjectId: "", chapterId: "", topicId: "", topic: "",
    type: "OTHER", priority: "MEDIUM", status: "TODO",
    date: partial.date || todayISO(), deadline: "",
    startTime: "", endTime: "", estimatedMinutes: 30, actualMinutes: 0,
    testId: "", createdAt: now, completedAt: "", notes: "",
    revisionId: "", // links an automatic spaced-revision Task back to its Revision record
    countsAsFirstStudy: false, // explicit trigger for starting a chapter's automatic revision chain
    ...partial,
    estimatedMinutes: safeNumber(partial.estimatedMinutes, 30),
    actualMinutes: safeNumber(partial.actualMinutes, 0),
  };
}

// StudySession
// { id, date, startTime, endTime, durationMinutes, subject, subjectId,
//   chapterId, topicId, topic, resourceId, lectureId, type, taskId,
//   notes, createdAt }
const SESSION_TYPES = ["LECTURE", "QUESTIONS", "REVISION", "PYQ", "NCERT", "TEST", "TEST_ANALYSIS", "OTHER"];
function makeStudySession(partial) {
  const merged = {
    id: partial.id || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    date: partial.date || todayISO(),
    startTime: "", endTime: "", durationMinutes: 0,
    subject: "", subjectId: "", chapterId: "", topicId: "", topic: "",
    resourceId: "", lectureId: "", type: "OTHER", taskId: "", notes: "",
    createdAt: new Date().toISOString(),
    ...partial,
  };
  merged.durationMinutes = Math.max(0, safeNumber(merged.durationMinutes, 0));
  return merged;
}

// Resource
// { id, name, source, subjectId, chapterId, topicId, type, url,
//   description, status, tags, createdAt, updatedAt, notes }
const RESOURCE_TYPES = ["LECTURE", "NOTES", "DPP", "QUESTION_BANK", "PYQ", "JEE_MAIN", "NCERT", "MODULE", "TEST", "PDF", "VIDEO", "WEBSITE", "PERSONAL_NOTES", "OTHER"];
const RESOURCE_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "NEEDS_REVISION", "ARCHIVED"];
const RESOURCE_SOURCES = ["PW Lakshya 2027", "PW", "NEETPrep", "NCERT", "PYQ", "JEE Main", "AITS", "Relentless", "Personal", "Other"];
function makeResource(partial) {
  const now = new Date().toISOString();
  return {
    id: partial.id || `res_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: "", source: "Personal", subjectId: "", chapterId: "", topicId: "",
    type: "OTHER", url: "", description: "", status: "NOT_STARTED",
    tags: [], createdAt: now, updatedAt: now, notes: "",
    ...partial,
  };
}

// Lecture — belongs to a Resource (typically a RESOURCE_TYPE "LECTURE" series) and Chapter.
// { id, resourceId, chapterId, topicId, lectureNumber, title,
//   durationMinutes, manualComplete, completedAt, notes }
// watchedMinutes/status are DERIVED from linked StudySessions (see
// getLectureProgress) rather than stored, so they can never drift
// out of sync with actual logged study time.
const LECTURE_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED", "REWATCH"];
function makeLecture(partial) {
  return {
    id: partial.id || `lec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    resourceId: "", chapterId: "", topicId: "", lectureNumber: 1, title: "",
    durationMinutes: 30, manualComplete: false, completedAt: "", notes: "",
    ...partial,
  };
}

// Question — normalized, single source of truth. Important/Mistake are
// metadata fields on the SAME record (never a separate cloned object),
// so a question can be isImportant AND isMistake simultaneously, and
// editing/deleting it is instantly reflected everywhere it's shown.
const QUESTION_SOURCES = ["PW", "PW DPP", "PW Class Questions", "NEETPrep", "NCERT", "PYQ", "JEE Main", "AITS", "Relentless", "Module", "Test", "Other"];
const QUESTION_DIFFICULTIES = ["Easy", "Medium", "Hard"];
const IMPORTANT_TAGS = ["Must Revise", "High Yield", "Tricky", "Repeated", "Conceptual", "NCERT Line", "PYQ", "Formula", "Common Trap"];
const MISTAKE_TYPES = ["Conceptual", "Calculation", "Formula", "Memory", "Silly", "Misread", "Time Pressure", "Guess"];

function makeQuestion(partial) {
  return {
    id: partial.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    questionText: "", image: "", subjectId: "", chapterId: "", topicId: "",
    source: "Other", sourceQuestionNumber: "", difficulty: "Medium", tags: [],
    correctAnswer: "", myAnswer: "", isCorrect: null, explanation: "", notes: "",
    dateAdded: todayISO(),
    isImportant: false, importantTags: [], importantRevisionCount: 0, importantLastRevised: "", importantNextRevision: "",
    isMistake: false, mistakeType: "", mistakeNotes: "", correctApproach: "", mistakeRevisionCount: 0, mistakeLastRevised: "", mistakeNextRevision: "",
    ...partial,
  };
}

// Revision — normalized schedule record. targetType+targetId points at
// the real entity (question/chapter/task); never a copy of its data.
const REVISION_TARGET_TYPES = ["question", "chapter", "task"];
const REVISION_TYPES = ["Important Question", "Mistake", "Chapter Revision", "Manual Revision"];
const REVISION_STATUSES = ["SCHEDULED", "COMPLETED"];
const REVISION_INTERVALS_DAYS = [1, 3, 7, 14, 30]; // Revision 1→1d, 2→3d, 3→7d, 4→14d, 5+→30d

function makeRevision(partial) {
  return {
    id: partial.id || `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    targetType: "question", targetId: "", revisionType: "Manual Revision",
    revisionNumber: 1, scheduledDate: todayISO(), completedDate: "", status: "SCHEDULED", notes: "",
    ...partial,
  };
}
function intervalForRevisionNumber(n) {
  return REVISION_INTERVALS_DAYS[Math.min(Math.max(n, 1), REVISION_INTERVALS_DAYS.length) - 1];
}

/* ------------------------------------------------------------
   AUTOMATIC SPACED REVISION — subject-specific interval/duration
   settings (Settings-configurable, default 1/3/7/14/30 days per
   subject). These are separate from REVISION_INTERVALS_DAYS above,
   which remains the fixed schedule used for Important/Mistake
   question revisions — kept intentionally distinct per subject.
   ------------------------------------------------------------ */

const DEFAULT_SUBJECT_INTERVALS = [1, 3, 7, 14, 30];
function getSubjectIntervals(subjectId, settings) {
  const raw = settings?.revisionIntervals?.[subjectId];
  if (Array.isArray(raw) && raw.length > 0) {
    const cleaned = raw.map((n) => Math.min(365, Math.max(1, Math.round(safeNumber(n, 1)))));
    if (cleaned.every((n) => Number.isFinite(n))) return cleaned;
  }
  return DEFAULT_SUBJECT_INTERVALS;
}
function getSubjectRevisionDuration(subjectId, settings) {
  const fallback = subjectId === "biology" ? 30 : 45;
  return Math.max(5, Math.min(240, Math.round(safeNumber(settings?.revisionDurations?.[subjectId], fallback))));
}
function intervalForSubjectRevision(subjectId, revisionNumber, settings) {
  const intervals = getSubjectIntervals(subjectId, settings);
  return intervals[Math.min(Math.max(revisionNumber, 1), intervals.length) - 1];
}

// Test — normalized. Result fields live ON the test record (never a
// separate cloned "result" entity) since a test has exactly one result.
const TEST_STATUSES = ["Upcoming", "Completed", "Missed", "Cancelled"];
function makeTest(partial) {
  return {
    id: partial.id || `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    testNumber: "", name: "", date: partial.date || todayISO(), series: "", notes: "",
    status: "Upcoming", maxScore: 720,
    score: null, correct: null, wrong: null, unattempted: null, accuracy: null,
    subjectScores: { physics: null, chemistry: null, biology: null },
    sourcePlanner: "", sourceTestNumber: "", // traceability for imported schedules — never required, never breaks the schema
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

// TestSyllabus — references an existing chapter/topic by ID; never
// stores a copy of the chapter's name/data.
const TEST_SECTIONS = ["Physics", "Chemistry", "Botany", "Zoology"];
function makeTestSyllabusEntry(partial) {
  return {
    id: partial.id || `tsyl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    testId: "", subjectId: "", chapterId: "", topicId: "", section: "Physics",
    ...partial,
  };
}

// Best-effort Botany/Zoology labeling for display grouping only — NTA
// doesn't officially split Biology this way; this follows the common
// coaching-institute convention (plant-related chapters → Botany,
// everything else in Biology → Zoology) seen in the uploaded test
// planners. It never affects readiness math, only which column a
// chapter's syllabus entry is grouped under.
const BOTANY_CHAPTER_IDS = new Set([
  "bio11_01", "bio11_02", "bio11_03", "bio11_05", "bio11_06",
  "bio11_08", "bio11_09", "bio11_10", "bio11_11", "bio11_12", "bio11_13",
  "bio12_01",
]);
function biologySection(chapterId) {
  return BOTANY_CHAPTER_IDS.has(chapterId) ? "Botany" : "Zoology";
}
function sectionForChapter(chapter) {
  if (chapter.subjectId === "physics") return "Physics";
  if (chapter.subjectId === "chemistry") return "Chemistry";
  return biologySection(chapter.id);
}

// TestAnalysis — links a wrong answer back to the ONE canonical
// Question record; never clones it.
function makeTestAnalysis(partial) {
  return {
    id: partial.id || `tan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    testId: "", questionId: "", chapterId: "", topicId: "",
    mistakeType: "Conceptual", correctApproach: "", notes: "", taskId: "",
    createdAt: new Date().toISOString(),
    ...partial,
  };
}


function makeCalendarEvent(partial) {
  return {
    id: partial.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: "", date: partial.date || todayISO(), startTime: "", endTime: "",
    taskId: "", type: "OTHER", notes: "",
    ...partial,
  };
}

// DailyPlan — { date, capacityMinutes, taskIds }
function makeDailyPlan(partial) {
  return {
    date: partial.date || todayISO(),
    capacityMinutes: partial.capacityMinutes ?? 480,
    taskIds: partial.taskIds || [],
  };
}

/* Backlog is derived from overdue Tasks (no separate BacklogItem entity).
   Weekly reflections persist under weeklyReviews keyed by weekStart. */

/* ------------------------------------------------------------
   FOCUS TIMER (STEP 3) — the one and only timer implementation.
   Persisted to storage as it runs so navigating away, or closing
   and reopening the artifact, never destroys an in-progress
   session. See TimerProvider below the AppDataProvider.
   ------------------------------------------------------------ */

const TIMER_MODES = { FOCUS: "FOCUS", SHORT_BREAK: "SHORT_BREAK", LONG_BREAK: "LONG_BREAK" };
const DEFAULT_DURATIONS = { FOCUS: 50, SHORT_BREAK: 5, LONG_BREAK: 15 };
function idleTimerState() {
  return { status: "idle", mode: "FOCUS", durationSeconds: 0, startedAt: null, pausedRemainingSeconds: 0, context: {} };
}

function dateToISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayISO() {
  return dateToISO(new Date());
}

/* ------------------------------------------------------------
   CANONICAL SYLLABUS — single source of truth for Subject →
   Class → Chapter → Topic. Every other module (Tasks, Sessions,
   Questions, Mistakes, Resources, Tests, Revisions) references
   these same chapterId/topicId values — nothing duplicates them.
   Chapter list matches the current NEET syllabus as reflected in
   2026-27 coaching test planners (NCERT-aligned). Topics are a
   representative subset, not exhaustive, and are safe to extend
   later without touching any UI code.
   ------------------------------------------------------------ */

const SUBJECTS = [
  { id: "physics", name: "Physics" },
  { id: "chemistry", name: "Chemistry" },
  { id: "biology", name: "Biology" },
];

const REVISION_TARGET = 3; // planned-revision policy, not fabricated history

function ch(id, subjectId, classLevel, name, topics = []) {
  return { id, subjectId, classLevel, name, topics: topics.map((t, i) => ({ id: `${id}_t${i + 1}`, name: t })) };
}

const CHAPTERS = [
  // ---- Physics — Class 11 ----
  ch("phy11_01", "physics", 11, "Units and Measurements", ["Physical quantities & units", "Errors in measurement", "Significant figures", "Dimensional analysis"]),
  ch("phy11_02", "physics", 11, "Motion in a Straight Line", ["Position & displacement", "Velocity & acceleration", "Equations of motion"]),
  ch("phy11_03", "physics", 11, "Motion in a Plane", ["Vectors", "Projectile motion", "Circular motion"]),
  ch("phy11_04", "physics", 11, "Laws of Motion", ["Newton's laws", "Friction", "Circular motion dynamics"]),
  ch("phy11_05", "physics", 11, "Work, Energy and Power", ["Work-energy theorem", "Conservation of energy", "Power"]),
  ch("phy11_06", "physics", 11, "System of Particles and Rotational Motion", ["Centre of mass", "Torque & angular momentum", "Moment of inertia"]),
  ch("phy11_07", "physics", 11, "Gravitation", ["Kepler's laws", "Gravitational potential energy", "Escape velocity & satellites"]),
  ch("phy11_08", "physics", 11, "Mechanical Properties of Solids", ["Stress & strain", "Elastic moduli", "Applications"]),
  ch("phy11_09", "physics", 11, "Mechanical Properties of Fluids", ["Pressure & Pascal's law", "Viscosity", "Surface tension"]),
  ch("phy11_10", "physics", 11, "Thermal Properties of Matter", ["Temperature & heat", "Thermal expansion", "Calorimetry & change of state"]),
  ch("phy11_11", "physics", 11, "Thermodynamics", ["Zeroth & first law", "Thermodynamic processes", "Second law & heat engines"]),
  ch("phy11_12", "physics", 11, "Kinetic Theory of Gases", ["Kinetic theory postulates", "Gas laws", "Degrees of freedom"]),
  ch("phy11_13", "physics", 11, "Oscillations", ["Simple harmonic motion", "Energy in SHM", "Damped & forced oscillations"]),
  ch("phy11_14", "physics", 11, "Waves", ["Wave motion", "Superposition & standing waves", "Doppler effect"]),
  // ---- Physics — Class 12 ----
  ch("phy12_01", "physics", 12, "Electric Charges and Fields", ["Coulomb's law", "Electric field", "Gauss's law"]),
  ch("phy12_02", "physics", 12, "Electrostatic Potential and Capacitance", ["Potential & potential energy", "Capacitors", "Dielectrics"]),
  ch("phy12_03", "physics", 12, "Current Electricity", ["Ohm's law", "Kirchhoff's laws", "Cells & combinations"]),
  ch("phy12_04", "physics", 12, "Moving Charges and Magnetism", ["Biot-Savart law", "Ampere's law", "Force on moving charges"]),
  ch("phy12_05", "physics", 12, "Magnetism and Matter", ["Bar magnet", "Earth's magnetism", "Magnetic materials"]),
  ch("phy12_06", "physics", 12, "Electromagnetic Induction", ["Faraday's law", "Lenz's law", "Self & mutual inductance"]),
  ch("phy12_07", "physics", 12, "Alternating Current", ["AC circuits", "LCR circuits", "Transformers"]),
  ch("phy12_08", "physics", 12, "Electromagnetic Waves", ["Displacement current", "EM spectrum", "Properties of EM waves"]),
  ch("phy12_09", "physics", 12, "Ray Optics and Optical Instruments", ["Reflection & refraction", "Lenses & mirrors", "Optical instruments"]),
  ch("phy12_10", "physics", 12, "Wave Optics", ["Huygens' principle", "Interference", "Diffraction & polarisation"]),
  ch("phy12_11", "physics", 12, "Dual Nature of Radiation and Matter", ["Photoelectric effect", "Einstein's equation", "de Broglie wavelength"]),
  ch("phy12_12", "physics", 12, "Atoms", ["Rutherford model", "Bohr model", "Spectral lines"]),
  ch("phy12_13", "physics", 12, "Nuclei", ["Nuclear structure", "Radioactivity", "Nuclear energy"]),
  ch("phy12_14", "physics", 12, "Semiconductor Electronics", ["Semiconductors & diodes", "p-n junction", "Logic gates"]),
  // ---- Chemistry — Class 11 ----
  ch("chem11_01", "chemistry", 11, "Some Basic Concepts of Chemistry", ["Mole concept", "Stoichiometry", "Laws of chemical combination"]),
  ch("chem11_02", "chemistry", 11, "Structure of Atom", ["Atomic models", "Quantum numbers", "Electronic configuration"]),
  ch("chem11_03", "chemistry", 11, "Classification of Elements and Periodicity", ["Modern periodic law", "Periodic trends", "s/p/d/f block overview"]),
  ch("chem11_04", "chemistry", 11, "Chemical Bonding and Molecular Structure", ["Ionic & covalent bonding", "VSEPR theory", "Hybridisation"]),
  ch("chem11_05", "chemistry", 11, "Thermodynamics", ["First law & enthalpy", "Entropy", "Gibbs energy & spontaneity"]),
  ch("chem11_06", "chemistry", 11, "Equilibrium", ["Chemical equilibrium", "Acids & bases", "Ionic equilibrium"]),
  ch("chem11_07", "chemistry", 11, "Redox Reactions", ["Oxidation & reduction", "Balancing redox reactions", "Electrode processes"]),
  ch("chem11_08", "chemistry", 11, "Organic Chemistry: Basic Principles and Techniques", ["IUPAC nomenclature", "Isomerism", "Reaction mechanisms"]),
  ch("chem11_09", "chemistry", 11, "Hydrocarbons", ["Alkanes", "Alkenes & alkynes", "Aromatic hydrocarbons"]),
  // ---- Chemistry — Class 12 ----
  ch("chem12_01", "chemistry", 12, "Solutions", ["Concentration terms", "Colligative properties", "Abnormal molar mass"]),
  ch("chem12_02", "chemistry", 12, "Electrochemistry", ["Electrochemical cells", "Nernst equation", "Conductance"]),
  ch("chem12_03", "chemistry", 12, "Chemical Kinetics", ["Rate of reaction", "Order & molecularity", "Arrhenius equation"]),
  ch("chem12_04", "chemistry", 12, "The d and f Block Elements", ["Transition elements", "Lanthanoids & actinoids", "Properties & trends"]),
  ch("chem12_05", "chemistry", 12, "Coordination Compounds", ["Werner's theory", "Nomenclature", "Bonding theories"]),
  ch("chem12_06", "chemistry", 12, "The p-Block Elements (Group 13 to 18)", ["Group trends", "Important compounds", "Anomalous behaviour"]),
  ch("chem12_07", "chemistry", 12, "Salt Analysis", ["Cation tests", "Anion tests", "Confirmatory tests"]),
  ch("chem12_08", "chemistry", 12, "Organic Chemistry: Purification and Analysis", ["Purification methods", "Qualitative analysis", "Quantitative analysis"]),
  ch("chem12_09", "chemistry", 12, "Haloalkanes and Haloarenes", ["Nomenclature & preparation", "SN1/SN2 reactions", "Properties"]),
  ch("chem12_10", "chemistry", 12, "Alcohols, Phenols and Ethers", ["Preparation methods", "Chemical properties", "Distinction tests"]),
  ch("chem12_11", "chemistry", 12, "Aldehydes, Ketones and Carboxylic Acids", ["Nomenclature & preparation", "Nucleophilic addition", "Acidity & reactions"]),
  ch("chem12_12", "chemistry", 12, "Amines", ["Classification & preparation", "Basicity", "Diazonium salts"]),
  ch("chem12_13", "chemistry", 12, "Biomolecules", ["Carbohydrates", "Proteins", "Nucleic acids"]),
  ch("chem12_14", "chemistry", 12, "Surface Chemistry", ["Adsorption", "Colloids", "Catalysis"]),
  // ---- Biology — Class 11 ----
  ch("bio11_01", "biology", 11, "The Living World", ["Diversity of life", "Taxonomic categories", "Nomenclature"]),
  ch("bio11_02", "biology", 11, "Biological Classification", ["Five kingdom system", "Monera & Protista", "Kingdom Fungi"]),
  ch("bio11_03", "biology", 11, "Plant Kingdom", ["Algae & bryophytes", "Pteridophytes & gymnosperms", "Plant life cycles"]),
  ch("bio11_04", "biology", 11, "Animal Kingdom", ["Classification basis", "Non-chordates", "Chordates"]),
  ch("bio11_05", "biology", 11, "Morphology of Flowering Plants", ["Root, stem & leaf", "Inflorescence & flower", "Fruit & seed"]),
  ch("bio11_06", "biology", 11, "Anatomy of Flowering Plant", ["Plant tissues", "Anatomy of root/stem/leaf", "Secondary growth"]),
  ch("bio11_07", "biology", 11, "Structural Organisation in Animals", ["Animal tissues", "Earthworm & cockroach", "Frog morphology"]),
  ch("bio11_08", "biology", 11, "Cell: The Unit of Life", ["Cell theory", "Cell organelles", "Prokaryotic & eukaryotic cells"]),
  ch("bio11_09", "biology", 11, "Biomolecules", ["Carbohydrates & lipids", "Proteins & enzymes", "Nucleic acids"]),
  ch("bio11_10", "biology", 11, "Cell Cycle and Cell Division", ["Cell cycle phases", "Mitosis", "Meiosis"]),
  ch("bio11_11", "biology", 11, "Photosynthesis in Higher Plants", ["Light reactions", "Calvin cycle", "C3/C4 pathways"]),
  ch("bio11_12", "biology", 11, "Respiration in Plants", ["Glycolysis", "Krebs cycle", "Electron transport & ATP synthesis"]),
  ch("bio11_13", "biology", 11, "Plant Growth and Development", ["Growth phases", "Plant hormones", "Photoperiodism & vernalisation"]),
  ch("bio11_14", "biology", 11, "Breathing and Exchange of Gases", ["Respiratory organs", "Mechanism of breathing", "Gas transport"]),
  ch("bio11_15", "biology", 11, "Body Fluids and Circulation", ["Blood & lymph", "Heart & cardiac cycle", "ECG & disorders"]),
  ch("bio11_16", "biology", 11, "Excretory Products and their Elimination", ["Excretory organs", "Nephron & urine formation", "Regulation of kidney function"]),
  ch("bio11_17", "biology", 11, "Locomotion and Movement", ["Types of movement", "Skeletal system", "Muscle contraction"]),
  ch("bio11_18", "biology", 11, "Neural Control and Coordination", ["Neuron & nerve impulse", "Central nervous system", "Reflex action"]),
  ch("bio11_19", "biology", 11, "Chemical Coordination and Integration", ["Endocrine glands", "Hormones & mechanism of action", "Hypothalamus-pituitary axis"]),
  // ---- Biology — Class 12 ----
  ch("bio12_01", "biology", 12, "Sexual Reproduction in Flowering Plants", ["Flower structure", "Pollination", "Fertilisation & seed formation"]),
  ch("bio12_02", "biology", 12, "Human Reproduction", ["Reproductive systems", "Gametogenesis", "Menstrual cycle"]),
  ch("bio12_03", "biology", 12, "Reproductive Health", ["Reproductive health issues", "Contraception", "Infertility & ART"]),
  ch("bio12_04", "biology", 12, "Principles of Inheritance and Variation", ["Mendelian inheritance", "Chromosomal theory", "Genetic disorders"]),
  ch("bio12_05", "biology", 12, "Molecular Basis of Inheritance", ["DNA structure & replication", "Transcription & translation", "Gene regulation"]),
  ch("bio12_06", "biology", 12, "Evolution", ["Origin of life", "Evidences of evolution", "Mechanisms of evolution"]),
  ch("bio12_07", "biology", 12, "Human Health and Disease", ["Common diseases", "Immunity", "Drugs & alcohol abuse"]),
  ch("bio12_08", "biology", 12, "Microbes in Human Welfare", ["Microbes in food & industry", "Sewage treatment", "Biofertilisers & biocontrol"]),
  ch("bio12_09", "biology", 12, "Biotechnology: Principles and Processes", ["Genetic engineering tools", "rDNA technology", "Cloning vectors"]),
  ch("bio12_10", "biology", 12, "Biotechnology and its Applications", ["Agricultural applications", "Medical applications", "GMOs & biosafety"]),
  ch("bio12_11", "biology", 12, "Organisms and Populations", ["Population attributes", "Population interactions", "Adaptations"]),
  ch("bio12_12", "biology", 12, "Ecosystem", ["Structure & function", "Energy flow", "Ecological pyramids & succession"]),
  ch("bio12_13", "biology", 12, "Biodiversity and Conservation", ["Biodiversity patterns", "Loss of biodiversity", "Conservation strategies"]),
];

/* ------------------------------------------------------------
   REAL TEST SCHEDULE IMPORT (STEP 13) — transcribed directly from
   the two source planners supplied in this conversation:
     - NEETprep VITAL Classroom Test Series
     - PW Lakshya NEET 2027 Test Planner
   This is NOT a generic/generated schedule. Where the source PDF's
   text extraction was too jumbled to confidently reconstruct a
   row (NEETprep tests 1–6, whose dates/syllabus blocks interleaved
   ambiguously), those rows are deliberately omitted rather than
   guessed — flagged in the import report, not silently invented.
   A handful of individual PW rows have a Botany/Zoology column
   that visually merged in extraction; those are marked section:
   "UNCLEAR" below so the import preview flags them for manual
   review instead of guessing which sub-section they belong to.
   ------------------------------------------------------------ */

function st(section, chapterName) { return { section, chapterName }; }

const NEETPREP_VITAL_TESTS = [
  // Tests 1–6: the source PDF's raw text-extraction interleaved these six
  // rows' dates and chapter blocks out of order (3 "Warmup" rows plus 3
  // main rows, all jumbled together). Each individual date→syllabus PAIR
  // below IS read directly and unambiguously from the source (each date
  // sits immediately beside its own Physics/Chemistry/Biology block in
  // the raw text). What required inference was the TEST NUMBER assigned
  // to each pair, since the six numbers "1 2 3 4 5 6" appeared as a
  // detached header, not attached to individual rows. That numbering is
  // recovered here by chronological order (earliest date = Test 1, same
  // convention every other test in this series follows) and cross-
  // checked against tests 7/11/13 below, which repeat the exact same
  // three main-row syllabus blocks later in the cycle — strong internal
  // corroboration that the pairing (not just the numbering) is correct.
  { testNumber: "1", date: "2026-03-15", name: "Test 1 (Warmup)", notes: "Test-number assignment inferred from chronological order + cross-check against later repeats of this content (see comment above) — not directly labeled on this row in the source extraction.", syllabus: [
    st("Physics", "Mechanical Properties of Fluids"), st("Physics", "Thermal Properties of Matter"),
    st("Chemistry", "Equilibrium"), st("Chemistry", "Redox Reactions"),
    st("Biology", "Cell: The Unit of Life"), st("Biology", "Biomolecules"), st("Biology", "Cell Cycle and Cell Division"),
  ]},
  { testNumber: "2", date: "2026-04-05", name: "Test 2 (Warmup)", notes: "Test-number assignment inferred from chronological order + cross-check against later repeats of this content (see comment above) — not directly labeled on this row in the source extraction.", syllabus: [
    st("Physics", "Thermodynamics"), st("Physics", "Kinetic Theory of Gases"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"),
    st("Biology", "Photosynthesis in Higher Plants"), st("Biology", "Breathing and Exchange of Gases"), st("Biology", "Body Fluids and Circulation"), st("Biology", "Excretory Products and their Elimination"),
  ]},
  { testNumber: "3", date: "2026-04-26", name: "Test 3 (Warmup)", notes: "Test-number assignment inferred from chronological order + cross-check against later repeats of this content (see comment above) — not directly labeled on this row in the source extraction.", syllabus: [
    st("Physics", "Oscillations"), st("Physics", "Waves"),
    st("Chemistry", "Hydrocarbons"),
    st("Biology", "Respiration in Plants"), st("Biology", "Plant Growth and Development"), st("Biology", "Locomotion and Movement"), st("Biology", "Neural Control and Coordination"), st("Biology", "Chemical Coordination and Integration"),
  ]},
  { testNumber: "4", date: "2026-06-14", name: "Test 4", notes: "Test-number assignment inferred from chronological order (see comment above) — not directly labeled on this row in the source extraction.", syllabus: [
    st("Physics", "Units and Measurements"), st("Physics", "Motion in a Straight Line"), st("Physics", "Motion in a Plane"), st("Physics", "Laws of Motion"), st("Physics", "Work, Energy and Power"),
    st("Chemistry", "Some Basic Concepts of Chemistry"), st("Chemistry", "Structure of Atom"), st("Chemistry", "Classification of Elements and Periodicity"), st("Chemistry", "Chemical Bonding and Molecular Structure"),
    st("Biology", "The Living World"), st("Biology", "Biological Classification"), st("Biology", "Plant Kingdom"), st("Biology", "Animal Kingdom"), st("Biology", "Structural Organisation in Animals"),
  ]},
  { testNumber: "5", date: "2026-07-12", name: "Test 5", notes: "Test-number assignment inferred from chronological order (see comment above) — not directly labeled on this row in the source extraction.", syllabus: [
    st("Physics", "System of Particles and Rotational Motion"), st("Physics", "Gravitation"), st("Physics", "Mechanical Properties of Solids"), st("Physics", "Mechanical Properties of Fluids"),
    st("Chemistry", "Thermodynamics"), st("Chemistry", "Equilibrium"), st("Chemistry", "Redox Reactions"),
    st("Biology", "Morphology of Flowering Plants"), st("Biology", "Anatomy of Flowering Plant"), st("Biology", "Breathing and Exchange of Gases"), st("Biology", "Body Fluids and Circulation"), st("Biology", "Excretory Products and their Elimination"),
  ]},
  { testNumber: "6", date: "2026-08-09", name: "Test 6", notes: "Test-number assignment inferred from chronological order (see comment above) — not directly labeled on this row in the source extraction.", syllabus: [
    st("Physics", "Thermal Properties of Matter"), st("Physics", "Thermodynamics"), st("Physics", "Kinetic Theory of Gases"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Hydrocarbons"),
    st("Biology", "Photosynthesis in Higher Plants"), st("Biology", "Respiration in Plants"), st("Biology", "Plant Growth and Development"), st("Biology", "Locomotion and Movement"), st("Biology", "Neural Control and Coordination"), st("Biology", "Chemical Coordination and Integration"),
  ]},
  { testNumber: "7", date: "2026-09-06", name: "Test 7", notes: "", syllabus: [
    st("Physics", "Oscillations"), st("Physics", "Waves"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Hydrocarbons"),
    st("Biology", "Cell: The Unit of Life"), st("Biology", "Biomolecules"), st("Biology", "Cell Cycle and Cell Division"),
  ]},
  { testNumber: "8", date: "2026-09-27", name: "Test 8", notes: "", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Physics", "Electrostatic Potential and Capacitance"), st("Physics", "Current Electricity"),
    st("Chemistry", "Solutions"), st("Chemistry", "Electrochemistry"), st("Chemistry", "Chemical Kinetics"),
    st("Biology", "Sexual Reproduction in Flowering Plants"), st("Biology", "Human Reproduction"), st("Biology", "Reproductive Health"),
  ]},
  { testNumber: "9", date: "2026-10-11", name: "Test 9", notes: "", syllabus: [
    st("Physics", "Units and Measurements"), st("Physics", "Motion in a Straight Line"), st("Physics", "Motion in a Plane"), st("Physics", "Laws of Motion"), st("Physics", "Work, Energy and Power"),
    st("Chemistry", "Some Basic Concepts of Chemistry"), st("Chemistry", "Structure of Atom"), st("Chemistry", "Classification of Elements and Periodicity"), st("Chemistry", "Chemical Bonding and Molecular Structure"),
    st("Biology", "The Living World"), st("Biology", "Biological Classification"), st("Biology", "Plant Kingdom"), st("Biology", "Animal Kingdom"), st("Biology", "Structural Organisation in Animals"),
  ]},
  { testNumber: "10", date: "2026-10-25", name: "Test 10", notes: "", syllabus: [
    st("Physics", "Moving Charges and Magnetism"), st("Physics", "Magnetism and Matter"), st("Physics", "Electromagnetic Induction"), st("Physics", "Alternating Current"), st("Physics", "Electromagnetic Waves"),
    st("Chemistry", "The d and f Block Elements"), st("Chemistry", "Coordination Compounds"), st("Chemistry", "The p-Block Elements (Group 13 to 18)"), st("Chemistry", "Salt Analysis"),
    st("Biology", "Principles of Inheritance and Variation"), st("Biology", "Molecular Basis of Inheritance"), st("Biology", "Evolution"),
  ]},
  { testNumber: "11", date: "2026-11-08", name: "Test 11", notes: "", syllabus: [
    st("Physics", "System of Particles and Rotational Motion"), st("Physics", "Gravitation"), st("Physics", "Mechanical Properties of Solids"), st("Physics", "Mechanical Properties of Fluids"),
    st("Chemistry", "Thermodynamics"), st("Chemistry", "Equilibrium"), st("Chemistry", "Redox Reactions"),
    st("Biology", "Morphology of Flowering Plants"), st("Biology", "Anatomy of Flowering Plant"), st("Biology", "Breathing and Exchange of Gases"), st("Biology", "Body Fluids and Circulation"), st("Biology", "Excretory Products and their Elimination"),
  ]},
  { testNumber: "12", date: "2026-11-22", name: "Test 12", notes: "", syllabus: [
    st("Physics", "Ray Optics and Optical Instruments"), st("Physics", "Wave Optics"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Haloalkanes and Haloarenes"), st("Chemistry", "Alcohols, Phenols and Ethers"),
    st("Biology", "Microbes in Human Welfare"), st("Biology", "Biotechnology: Principles and Processes"), st("Biology", "Biotechnology and its Applications"), st("Biology", "Human Health and Disease"),
  ]},
  { testNumber: "13", date: "2026-12-06", name: "Test 13", notes: "", syllabus: [
    st("Physics", "Thermal Properties of Matter"), st("Physics", "Thermodynamics"), st("Physics", "Kinetic Theory of Gases"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Hydrocarbons"),
    st("Biology", "Photosynthesis in Higher Plants"), st("Biology", "Respiration in Plants"), st("Biology", "Plant Growth and Development"), st("Biology", "Locomotion and Movement"), st("Biology", "Neural Control and Coordination"), st("Biology", "Chemical Coordination and Integration"),
  ]},
  { testNumber: "14", date: "2026-12-20", name: "Test 14", notes: "", syllabus: [
    st("Physics", "Dual Nature of Radiation and Matter"), st("Physics", "Atoms"), st("Physics", "Nuclei"), st("Physics", "Semiconductor Electronics"),
    st("Chemistry", "Aldehydes, Ketones and Carboxylic Acids"), st("Chemistry", "Amines"), st("Chemistry", "Biomolecules"),
    st("Biology", "Organisms and Populations"), st("Biology", "Ecosystem"), st("Biology", "Biodiversity and Conservation"),
  ]},
  { testNumber: "15", date: "2027-01-03", name: "Test 15", notes: "", syllabus: [
    st("Physics", "Oscillations"), st("Physics", "Waves"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Hydrocarbons"),
    st("Biology", "Cell: The Unit of Life"), st("Biology", "Biomolecules"), st("Biology", "Cell Cycle and Cell Division"),
  ]},
  { testNumber: "16", date: "2027-01-17", name: "Test 16", notes: "", syllabus: [
    st("Physics", "Units and Measurements"), st("Physics", "Motion in a Straight Line"), st("Physics", "Motion in a Plane"), st("Physics", "Laws of Motion"), st("Physics", "Work, Energy and Power"), st("Physics", "System of Particles and Rotational Motion"),
    st("Chemistry", "Some Basic Concepts of Chemistry"), st("Chemistry", "Structure of Atom"), st("Chemistry", "Classification of Elements and Periodicity"), st("Chemistry", "Chemical Bonding and Molecular Structure"), st("Chemistry", "Thermodynamics"),
    st("Biology", "The Living World"), st("Biology", "Biological Classification"), st("Biology", "Plant Kingdom"), st("Biology", "Animal Kingdom"), st("Biology", "Morphology of Flowering Plants"), st("Biology", "Anatomy of Flowering Plant"), st("Biology", "Structural Organisation in Animals"), st("Biology", "Cell: The Unit of Life"), st("Biology", "Biomolecules"), st("Biology", "Cell Cycle and Cell Division"),
  ]},
  { testNumber: "17", date: "2027-01-24", name: "Test 17", notes: "", syllabus: [
    st("Physics", "Mechanical Properties of Solids"), st("Physics", "Mechanical Properties of Fluids"), st("Physics", "Thermal Properties of Matter"), st("Physics", "Thermodynamics"), st("Physics", "Kinetic Theory of Gases"), st("Physics", "Oscillations"), st("Physics", "Waves"),
    st("Chemistry", "Equilibrium"), st("Chemistry", "Redox Reactions"), st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Hydrocarbons"),
    st("Biology", "Photosynthesis in Higher Plants"), st("Biology", "Respiration in Plants"), st("Biology", "Plant Growth and Development"), st("Biology", "Breathing and Exchange of Gases"), st("Biology", "Body Fluids and Circulation"), st("Biology", "Excretory Products and their Elimination"), st("Biology", "Locomotion and Movement"), st("Biology", "Neural Control and Coordination"), st("Biology", "Chemical Coordination and Integration"),
  ]},
  { testNumber: "18", date: "2027-01-31", name: "Test 18", notes: "", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Physics", "Electrostatic Potential and Capacitance"), st("Physics", "Current Electricity"), st("Physics", "Moving Charges and Magnetism"), st("Physics", "Magnetism and Matter"), st("Physics", "Electromagnetic Induction"), st("Physics", "Alternating Current"), st("Physics", "Electromagnetic Waves"),
    st("Chemistry", "Solutions"), st("Chemistry", "Electrochemistry"), st("Chemistry", "Chemical Kinetics"), st("Chemistry", "The d and f Block Elements"), st("Chemistry", "Coordination Compounds"), st("Chemistry", "The p-Block Elements (Group 13 to 18)"), st("Chemistry", "Salt Analysis"),
    st("Biology", "Sexual Reproduction in Flowering Plants"), st("Biology", "Human Reproduction"), st("Biology", "Reproductive Health"), st("Biology", "Principles of Inheritance and Variation"), st("Biology", "Molecular Basis of Inheritance"), st("Biology", "Evolution"),
  ]},
  { testNumber: "19", date: "2027-02-07", name: "Test 19", notes: "", syllabus: [
    st("Physics", "Ray Optics and Optical Instruments"), st("Physics", "Wave Optics"), st("Physics", "Dual Nature of Radiation and Matter"), st("Physics", "Atoms"), st("Physics", "Nuclei"), st("Physics", "Semiconductor Electronics"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Aldehydes, Ketones and Carboxylic Acids"), st("Chemistry", "Amines"), st("Chemistry", "Biomolecules"), st("Chemistry", "Haloalkanes and Haloarenes"), st("Chemistry", "Alcohols, Phenols and Ethers"),
    st("Biology", "Microbes in Human Welfare"), st("Biology", "Biotechnology: Principles and Processes"), st("Biology", "Biotechnology and its Applications"), st("Biology", "Organisms and Populations"), st("Biology", "Ecosystem"), st("Biology", "Biodiversity and Conservation"), st("Biology", "Human Health and Disease"),
  ]},
  { testNumber: "20", date: "2027-02-14", name: "Test 20 — All Chapters Class 11th", notes: "Source lists this as a full Class 11th syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "21", date: "2027-02-21", name: "Test 21 — All Chapters Class 12th", notes: "Source lists this as a full Class 12th syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "22", date: "2027-02-28", name: "Test 22 — All Chapters Class 11th", notes: "Source lists this as a full Class 11th syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "23", date: "2027-03-07", name: "Test 23 — All Chapters Class 12th", notes: "Source lists this as a full Class 12th syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "24", date: "2027-03-14", name: "Test 24 — Full NEET Syllabus", notes: "Source lists this as a full-syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "25", date: "2027-03-21", name: "Test 25 — Full NEET Syllabus", notes: "Source lists this as a full-syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "26", date: "2027-03-28", name: "Test 26 — Full NEET Syllabus", notes: "Source lists this as a full-syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "27", date: "2027-04-04", name: "Test 27 — Full NEET Syllabus", notes: "Source lists this as a full-syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "28", date: "2027-04-11", name: "Test 28 — Full NEET Syllabus", notes: "Source lists this as a full-syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "29", date: "2027-04-18", name: "Test 29 — Full NEET Syllabus", notes: "Source lists this as a full-syllabus test without enumerating individual chapters.", syllabus: [] },
  { testNumber: "30", date: "2027-04-25", name: "Test 30 — Full NEET Syllabus", notes: "Source lists this as a full-syllabus test without enumerating individual chapters.", syllabus: [] },
];
const NEETPREP_VITAL_SKIPPED_NOTE = "";

const PW_LAKSHYA_TESTS = [
  { testNumber: "1", date: "2026-04-26", name: "Short Test-1", notes: "Part Test · Short Test", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Chemistry", "Solutions"), st("Botany", "Sexual Reproduction in Flowering Plants"), st("Zoology", "Human Reproduction"),
  ]},
  { testNumber: "2", date: "2026-05-10", name: "NEET-1", notes: "Part Test · NEET", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Chemistry", "Solutions"), st("Botany", "Sexual Reproduction in Flowering Plants"), st("Zoology", "Human Reproduction"),
  ]},
  { testNumber: "3", date: "2026-05-24", name: "Short Test-2", notes: "Part Test · Short Test", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Chemistry", "Solutions"), st("Botany", "Sexual Reproduction in Flowering Plants"), st("Zoology", "Human Reproduction"),
  ]},
  { testNumber: "4", date: "2026-06-07", name: "NEET-2", notes: "Part Test · NEET", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Physics", "Electrostatic Potential and Capacitance"),
    st("Chemistry", "Solutions"), st("Chemistry", "Electrochemistry"),
    st("Botany", "Sexual Reproduction in Flowering Plants"),
    st("Zoology", "Principles of Inheritance and Variation"), st("Zoology", "Human Reproduction"),
  ]},
  { testNumber: "5", date: "2026-06-21", name: "Rank Booster Test-1", notes: "Part Test · Rank Booster Test", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Physics", "Electrostatic Potential and Capacitance"),
    st("Chemistry", "Solutions"), st("Chemistry", "Electrochemistry"),
    st("Botany", "Sexual Reproduction in Flowering Plants"),
    st("Zoology", "Principles of Inheritance and Variation"), st("Zoology", "Human Reproduction"),
  ]},
  { testNumber: "6", date: "2026-07-05", name: "NEET-3", notes: "Part Test · NEET", syllabus: [
    st("Physics", "Electrostatic Potential and Capacitance"), st("Physics", "Current Electricity"),
    st("Chemistry", "Electrochemistry"), st("Chemistry", "Chemical Kinetics"),
    st("Botany", "Principles of Inheritance and Variation"),
    st("Zoology", "Reproductive Health"),
  ]},
  { testNumber: "7", date: "2026-07-19", name: "NEET-4", notes: "Part Test · NEET", syllabus: [
    st("Physics", "Current Electricity"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"),
    st("Botany", "Principles of Inheritance and Variation"),
    st("Zoology", "Human Health and Disease"),
  ]},
  { testNumber: "8", date: "2026-08-09", name: "AITS-1", notes: "Part Test · NEET", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Chemistry", "Solutions"), st("Botany", "Sexual Reproduction in Flowering Plants"), st("Zoology", "Human Reproduction"),
  ]},
  { testNumber: "9", date: "2026-08-23", name: "Rank Booster Test-2", notes: "Part Test · Rank Booster Test", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Physics", "Electrostatic Potential and Capacitance"),
    st("Chemistry", "Solutions"), st("Chemistry", "Electrochemistry"), st("Chemistry", "Chemical Kinetics"),
    st("Botany", "Sexual Reproduction in Flowering Plants"), st("Botany", "Principles of Inheritance and Variation"),
    st("Zoology", "Human Reproduction"), st("Zoology", "Reproductive Health"), st("Zoology", "Human Health and Disease"),
  ]},
  { testNumber: "10", date: "2026-09-06", name: "Board Pattern Test-1", notes: "Part Test · Board Pattern Test. Source lists 'Complete Syllabus Till Date' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "11", date: "2026-09-20", name: "AITS-2", notes: "Part Test · NEET (source also references +30% questions from cumulative prior AITS syllabus, not enumerable as specific chapters).", syllabus: [
    st("Physics", "Current Electricity"), st("Physics", "Moving Charges and Magnetism"), st("Physics", "Magnetism and Matter"),
    st("Chemistry", "Chemical Kinetics"), st("Chemistry", "Haloalkanes and Haloarenes"), st("Chemistry", "Alcohols, Phenols and Ethers"),
    st("Botany", "Molecular Basis of Inheritance"),
    st("Zoology", "Reproductive Health"),
  ]},
  { testNumber: "12", date: "2026-10-04", name: "NEET-5", notes: "Part Test · NEET.", syllabus: [
    st("Physics", "Current Electricity"), st("Physics", "Moving Charges and Magnetism"), st("Physics", "Magnetism and Matter"), st("Physics", "Electromagnetic Induction"), st("Physics", "Alternating Current"), st("Physics", "Electromagnetic Waves"),
    st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Haloalkanes and Haloarenes"), st("Chemistry", "Alcohols, Phenols and Ethers"), st("Chemistry", "Aldehydes, Ketones and Carboxylic Acids"), st("Chemistry", "Amines"), st("Chemistry", "Biomolecules"),
    st("Botany", "Principles of Inheritance and Variation"), st("Zoology", "Biotechnology: Principles and Processes"),
  ]},
  { testNumber: "13", date: "2026-10-18", name: "NEET-6", notes: "Part Test · NEET.", syllabus: [
    st("Physics", "Ray Optics and Optical Instruments"),
    st("Chemistry", "Biomolecules"), st("Chemistry", "Organic Chemistry: Purification and Analysis"),
    st("Botany", "Molecular Basis of Inheritance"), st("Zoology", "Biotechnology: Principles and Processes"), st("Zoology", "Biotechnology and its Applications"),
  ]},
  { testNumber: "14", date: "2026-11-01", name: "AITS-3", notes: "Part Test · NEET (source also references +30% questions from cumulative prior AITS syllabus, not enumerable as specific chapters).", syllabus: [
    st("Physics", "Electromagnetic Induction"), st("Physics", "Alternating Current"), st("Physics", "Electromagnetic Waves"),
    st("Chemistry", "Aldehydes, Ketones and Carboxylic Acids"), st("Chemistry", "Amines"), st("Chemistry", "Biomolecules"),
    st("Botany", "Principles of Inheritance and Variation"), st("Botany", "Microbes in Human Welfare"),
    st("Zoology", "Human Health and Disease"),
  ]},
  { testNumber: "15", date: "2026-11-22", name: "Rank Booster Test-3", notes: "Part Test · Rank Booster Test", syllabus: [
    st("Physics", "Electric Charges and Fields"), st("Physics", "Electrostatic Potential and Capacitance"), st("Physics", "Current Electricity"), st("Physics", "Moving Charges and Magnetism"), st("Physics", "Magnetism and Matter"), st("Physics", "Electromagnetic Induction"), st("Physics", "Alternating Current"), st("Physics", "Electromagnetic Waves"), st("Physics", "Ray Optics and Optical Instruments"),
    st("Chemistry", "Solutions"), st("Chemistry", "Electrochemistry"), st("Chemistry", "Chemical Kinetics"), st("Chemistry", "Organic Chemistry: Basic Principles and Techniques"), st("Chemistry", "Haloalkanes and Haloarenes"), st("Chemistry", "Alcohols, Phenols and Ethers"), st("Chemistry", "Aldehydes, Ketones and Carboxylic Acids"), st("Chemistry", "Amines"), st("Chemistry", "Biomolecules"), st("Chemistry", "Organic Chemistry: Purification and Analysis"),
    st("Botany", "Sexual Reproduction in Flowering Plants"), st("Botany", "Principles of Inheritance and Variation"), st("Botany", "Molecular Basis of Inheritance"), st("Botany", "Microbes in Human Welfare"),
    st("Zoology", "Human Reproduction"), st("Zoology", "Reproductive Health"), st("Zoology", "Human Health and Disease"), st("Zoology", "Biotechnology: Principles and Processes"), st("Zoology", "Biotechnology and its Applications"),
  ]},
  { testNumber: "16", date: "2026-12-13", name: "AITS-4", notes: "Part Test · NEET (source also references +30% questions from cumulative prior AITS syllabus, not enumerable as specific chapters).", syllabus: [
    st("Physics", "Ray Optics and Optical Instruments"), st("Physics", "Wave Optics"), st("Physics", "Dual Nature of Radiation and Matter"), st("Physics", "Atoms"),
    st("Chemistry", "Coordination Compounds"), st("Chemistry", "The p-Block Elements (Group 13 to 18)"), st("Chemistry", "The d and f Block Elements"), st("Chemistry", "Salt Analysis"),
    st("Botany", "Organisms and Populations"), st("Botany", "Ecosystem"),
    st("Zoology", "Biotechnology: Principles and Processes"), st("Zoology", "Evolution"),
  ]},
  { testNumber: "17", date: "2026-12-27", name: "NEET-7", notes: "Part Test · NEET.", syllabus: [
    st("Physics", "Wave Optics"), st("Physics", "Dual Nature of Radiation and Matter"), st("Physics", "Atoms"), st("Physics", "Nuclei"), st("Physics", "Semiconductor Electronics"),
    st("Chemistry", "Coordination Compounds"), st("Chemistry", "The d and f Block Elements"), st("Chemistry", "The p-Block Elements (Group 13 to 18)"), st("Chemistry", "Salt Analysis"), st("Chemistry", "Surface Chemistry"),
    st("Zoology", "Biotechnology and its Applications"), st("Zoology", "Evolution"),
  ]},
  { testNumber: "18", date: "2027-01-03", name: "Rank Booster Test-4", notes: "Part Test · Rank Booster Test. Source lists 'Full Syllabus 12th' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "19", date: "2027-01-10", name: "NEET-8", notes: "Part Test · NEET. Source lists 'Full Syllabus 12th' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "20", date: "2027-01-17", name: "AITS-5", notes: "Full Test · NEET. Source lists '12th Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "21", date: "2027-01-24", name: "AITS-6", notes: "Full Test · NEET. Source lists '11th Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "22", date: "2027-01-31", name: "AITS-7", notes: "Full Test · NEET. Source lists 'Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "23", date: "2027-02-07", name: "Board Pattern Test-2", notes: "Part Test · Board Pattern Test. Source lists 'Full Syllabus' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "24", date: "2027-03-28", name: "AITS-8", notes: "Full Test · NEET. Source lists 'Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "25", date: "2027-04-04", name: "AITS-9", notes: "Full Test · NEET. Source lists 'Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "26", date: "2027-04-11", name: "AITS-10", notes: "Full Test · NEET. Source lists 'Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "27", date: "2027-04-18", name: "AITS-11", notes: "Full Test · NEET. Source lists 'Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
  { testNumber: "28", date: "2027-04-25", name: "AITS-12", notes: "Full Test · NEET. Source lists 'Full Syllabus as per NTA' for every subject without enumerating chapters.", syllabus: [] },
];

const IMPORT_SOURCE_PLANNERS = {
  neetprep_vital: { label: "NEETprep VITAL Classroom Test Series", series: "NEETprep VITAL Classroom Test Series", tests: NEETPREP_VITAL_TESTS, skippedNote: NEETPREP_VITAL_SKIPPED_NOTE },
  pw_lakshya: { label: "PW Lakshya NEET 2027 Test Planner", series: "Lakshya NEET 2027", tests: PW_LAKSHYA_TESTS, skippedNote: "" },
};

// Normalizes a source chapter-name string for matching against the
// canonical CHAPTERS list: lowercase, collapse whitespace, unify
// "&"/"and", drop a couple of cosmetic suffixes that don't appear
// consistently in the source vs. the canonical syllabus.
function normalizeChapterName(name) {
  return name.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
}
// Known naming differences between the source planners' wording and
// this app's canonical chapter names — every one of these is a real,
// verified same-chapter alias, not a guess.
const CHAPTER_NAME_ALIASES = {
  "some basic concepts of chemistry": "some basic concepts of chemistry",
  "human health and diseases": "human health and disease",
  "biotechnology: principles and processes": "biotechnology: principles and processes",
  "principle of inheritance and variation": "principles of inheritance and variation",
  "organisms and population": "organisms and populations",
  "sexual reproduction in flowering plant": "sexual reproduction in flowering plants",
};
function matchChapterName(sourceName) {
  const norm = normalizeChapterName(sourceName);
  const aliased = CHAPTER_NAME_ALIASES[norm] || norm;
  let found = CHAPTERS.find((c) => normalizeChapterName(c.name) === aliased);
  if (found) return found;
  // Safe fallback: one name fully containing the other (handles minor
  // punctuation/qualifier differences) — still a real textual match,
  // never a fuzzy/guessed one.
  found = CHAPTERS.find((c) => {
    const cn = normalizeChapterName(c.name);
    return cn.includes(aliased) || aliased.includes(cn);
  });
  return found || null;
}

const CHAPTER_CHECKLIST_DEFS = [
  { key: "lectures", label: "Lectures complete", derived: true },
  { key: "theory", label: "Theory complete", derived: false },
  { key: "ncert", label: "NCERT/reading complete", derived: true },
  { key: "questionsTarget", label: "Questions target complete", derived: false },
  { key: "pyq", label: "PYQs complete", derived: true },
  { key: "firstRevision", label: "First revision complete", derived: true },
];

// Lecture progress is derived from linked StudySessions, never stored,
// so it can't drift out of sync with actual logged study time.
function getLectureProgress(lecture, sessions) {
  const watchedMinutes = Math.min(
    lecture.durationMinutes,
    sessions.filter((s) => s.lectureId === lecture.id).reduce((s, x) => s + (x.durationMinutes || 0), 0)
  );
  let status = "NOT_STARTED";
  if (lecture.manualComplete || watchedMinutes >= lecture.durationMinutes) status = "COMPLETED";
  else if (watchedMinutes > 0) status = "IN_PROGRESS";
  return { watchedMinutes, status };
}

function getResourceProgress(resource, lectures, sessions) {
  if (resource.type === "LECTURE") {
    const own = lectures.filter((l) => l.resourceId === resource.id);
    const completed = own.filter((l) => getLectureProgress(l, sessions).status === "COMPLETED").length;
    return { kind: "lectures", completed, total: own.length };
  }
  return { kind: "status", status: resource.status };
}

function safeDiv(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function getHistoricalState(chapterId, chapterProgress = {}) {
  const h = chapterProgress?.[chapterId]?.historical || null;
  return h && typeof h === "object" ? h : null;
}

// Live activity + optional historical baseline. Historical numbers never
// create Sessions/Questions/Tasks/Revisions — they only adjust displayed
// chapter totals and readiness. Daily analytics (today/week/streak/heatmap)
// still read pure live records only.
function getChapterStats(chapterId, tasks, sessions, lectures = [], resources = [], questions = [], revisions = [], chapterProgress = {}) {
  const done = tasks.filter((t) => t.chapterId === chapterId && t.status === "COMPLETED");
  const chapterLectures = lectures.filter((l) => l.chapterId === chapterId);
  const liveLecturesCompleted = chapterLectures.filter((l) => getLectureProgress(l, sessions).status === "COMPLETED").length;
  const liveLecturesTotal = chapterLectures.length;
  const liveLecturesLogged = liveLecturesTotal > 0 ? liveLecturesCompleted : done.filter((t) => t.type === "LECTURE").length;
  const questionsLogged = done.filter((t) => t.type === "QUESTIONS").length;
  const pyqLogged = done.filter((t) => t.type === "PYQ").length;
  const ncertLogged = done.filter((t) => t.type === "NCERT").length;
  const revisionsLoggedLive = done.filter((t) => t.type === "REVISION").length;
  const chapterSessions = sessions.filter((s) => s.chapterId === chapterId);
  const studyMinutes = chapterSessions.reduce((s, x) => s + safeNumber(x.durationMinutes, 0), 0);
  const resourceCount = resources.filter((r) => r.chapterId === chapterId).length;
  const allDates = [...done.map((t) => t.completedAt || t.date), ...chapterSessions.map((s) => s.date)].filter(Boolean).sort();
  const lastStudiedLive = allDates.length ? allDates[allDates.length - 1] : null;

  const chapterQuestions = questions.filter((q) => q.chapterId === chapterId);
  const liveQCount = chapterQuestions.length;
  const liveQCorrect = chapterQuestions.filter((q) => q.isCorrect === true).length;
  const liveQIncorrect = chapterQuestions.filter((q) => q.isCorrect === false).length;
  const importantCount = chapterQuestions.filter((q) => q.isImportant).length;
  const mistakeCount = chapterQuestions.filter((q) => q.isMistake).length;
  const chapterQuestionIds = new Set(chapterQuestions.map((q) => q.id));
  const today = todayISO();
  const relevantRevisions = revisions.filter((r) =>
    (r.targetType === "chapter" && r.targetId === chapterId) ||
    (r.targetType === "question" && chapterQuestionIds.has(r.targetId))
  );
  const revisionsDueCount = relevantRevisions.filter((r) => r.status === "SCHEDULED" && r.scheduledDate <= today).length;
  const completedRevisionDates = relevantRevisions.filter((r) => r.status === "COMPLETED" && r.completedDate).map((r) => r.completedDate).sort();
  const lastRevisionLive = completedRevisionDates.length ? completedRevisionDates[completedRevisionDates.length - 1] : null;
  const qDates = chapterQuestions.map((q) => q.dateAdded).filter(Boolean).sort();
  const lastQuestionActivity = qDates.length ? qDates[qDates.length - 1] : null;

  const hist = getHistoricalState(chapterId, chapterProgress);
  const histLecturesCompleted = hist && hist.lecturesCompleted != null ? safeNumber(hist.lecturesCompleted, 0) : 0;
  const histLecturesTotal = hist && hist.lecturesTotal != null ? safeNumber(hist.lecturesTotal, 0) : 0;
  const histQuestions = hist && hist.questionsCompleted != null ? safeNumber(hist.questionsCompleted, 0) : 0;
  const histCorrect = hist && hist.historicalCorrect != null ? safeNumber(hist.historicalCorrect, 0) : 0;
  const histIncorrect = hist && hist.historicalIncorrect != null ? safeNumber(hist.historicalIncorrect, 0) : 0;
  const histPyqCompleted = hist && hist.pyqCompleted != null ? safeNumber(hist.pyqCompleted, 0) : 0;
  const histPyqTotal = hist && hist.pyqTotal != null ? safeNumber(hist.pyqTotal, 0) : 0;
  const histJeeCompleted = hist && hist.jeeCompleted != null ? safeNumber(hist.jeeCompleted, 0) : 0;
  const histJeeTotal = hist && hist.jeeTotal != null ? safeNumber(hist.jeeTotal, 0) : 0;
  const histRevisionCount = hist && hist.revisionCount != null ? safeNumber(hist.revisionCount, 0) : 0;
  const histLastStudied = hist?.lastStudied || null;
  const histLastRevised = hist?.lastRevised || null;
  const histTheory = !!hist?.theoryComplete;
  const histNcert = !!hist?.ncertComplete;

  const lecturesCompletedCount = Math.max(liveLecturesCompleted, histLecturesCompleted);
  const lecturesTotalCount = Math.max(liveLecturesTotal, histLecturesTotal);
  const lecturesLogged = lecturesTotalCount > 0 ? lecturesCompletedCount : Math.max(liveLecturesLogged, histLecturesCompleted);
  const qCount = liveQCount + histQuestions;
  const qCorrect = liveQCorrect + histCorrect;
  const qIncorrect = liveQIncorrect + histIncorrect;
  const qAccuracy = Math.round(safeDiv(qCorrect, qCorrect + qIncorrect) * 100);
  // Prefer live PYQ task log; historical pyqCompleted counts when live is empty.
  const pyqLoggedFinal = pyqLogged > 0 ? pyqLogged : (histPyqCompleted > 0 ? histPyqCompleted : 0);
  const ncertLoggedFinal = ncertLogged > 0 ? ncertLogged : (histNcert ? 1 : 0);
  const revisionsLogged = revisionsLoggedLive + histRevisionCount;
  const lastStudied = [lastStudiedLive, histLastStudied].filter(Boolean).sort().slice(-1)[0] || null;
  const lastRevision = [lastRevisionLive, histLastRevised].filter(Boolean).sort().slice(-1)[0] || null;

  return {
    lecturesLogged, lecturesTotalCount, lecturesCompletedCount,
    questionsLogged, pyqLogged: pyqLoggedFinal, ncertLogged: ncertLoggedFinal, revisionsLogged,
    studyMinutes, resourceCount, lastStudied,
    qCount, qCorrect, qIncorrect, qAccuracy, importantCount, mistakeCount,
    revisionsDueCount, lastRevision, lastQuestionActivity,
    // Live-only slices (never include historical) for today/analytics clarity
    liveQCount, liveQCorrect, liveQIncorrect, liveStudyMinutes: studyMinutes,
    historical: hist,
    histTheory, histNcert, histPyqCompleted, histPyqTotal, histJeeCompleted, histJeeTotal, histRevisionCount,
  };
}

function getChapterChecklist(stats, manual) {
  const items = CHAPTER_CHECKLIST_DEFS.map((def) => {
    let checked = false;
    if (def.key === "lectures") {
      checked = stats.lecturesTotalCount > 0
        ? stats.lecturesCompletedCount === stats.lecturesTotalCount
        : stats.lecturesLogged > 0;
    }
    else if (def.key === "ncert") checked = stats.ncertLogged > 0 || !!manual.ncert || !!stats.histNcert;
    else if (def.key === "pyq") checked = stats.pyqLogged > 0;
    else if (def.key === "firstRevision") checked = stats.revisionsLogged >= 1;
    else if (def.key === "theory") checked = !!manual.theory || !!stats.histTheory;
    else if (def.key === "questionsTarget") checked = !!manual.questionsTarget || (stats.qCount >= 50);
    else checked = !!manual[def.key];
    return { ...def, checked };
  });
  const checkedCount = items.filter((i) => i.checked).length;
  const overallProgress = Math.round((checkedCount / items.length) * 100);
  const testReady = overallProgress >= 80;
  return { items, checkedCount, overallProgress, testReady };
}

function getChapterStatus(stats, checklist) {
  if (checklist.checkedCount === 0 && stats.lecturesLogged === 0 && !stats.lastStudied && stats.qCount === 0) return "NOT_STARTED";
  // Weak: enough question volume to be meaningful, and accuracy/mistakes say it's shaky.
  if (stats.qCount >= 5 && (stats.qAccuracy < 60 || stats.mistakeCount >= 3)) return "WEAK";
  if (stats.revisionsDueCount > 0) return "REVISION_DUE";
  if (checklist.checkedCount === CHAPTER_CHECKLIST_DEFS.length) return "MASTERED";
  if (stats.revisionsLogged >= 1) return "STRONG";
  if (stats.lecturesLogged > 0 && stats.questionsLogged > 0 && stats.pyqLogged > 0) return "FIRST_STUDY_COMPLETED";
  if (stats.lecturesLogged > 0) return "LECTURES_COMPLETED";
  return "IN_PROGRESS";
}

/* ------------------------------------------------------------
   TEST READINESS ENGINE
   ------------------------------------------------------------
   Chapter readiness is a weighted blend of the SAME real signals
   already computed by getChapterStats/getChapterChecklist:

     Lecture/Theory  20%  — average of the "lectures" and "theory"
                            checklist items (each 0 or 100)
     NCERT           15%  — "ncert" checklist item (0 or 100)
     Questions       20%  — min(qCount / TEST_QUESTION_TARGET, 1) * 100
     Accuracy        15%  — qAccuracy, already 0–100, 0 with no attempts
     PYQ             10%  — "pyq" checklist item (0 or 100)
     Revision        10%  — 0 if a revision is currently overdue,
                            else min(revisionsLogged / REVISION_TARGET, 1) * 100
     Mistake status  10%  — 100 minus 20 per open mistake (floor 0);
                            50 (neutral) if the chapter has no questions yet

   Weights sum to 100. This is a documented heuristic, not an NTA
   formula — there is no such thing as an "official" readiness score.
   ------------------------------------------------------------ */

const TEST_QUESTION_TARGET_PER_CHAPTER = 50; // configurable estimate, not stored history
const READINESS_WEIGHTS = { lectureTheory: 20, ncert: 15, questions: 20, accuracy: 15, pyq: 10, revision: 10, mistake: 10 };

function getChapterReadiness(chapterId, tasks, sessions, lectures, resources, questions, revisions, chapterProgress = {}) {
  const stats = getChapterStats(chapterId, tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
  const checklist = getChapterChecklist(stats, chapterProgress[chapterId] || {});
  const checked = Object.fromEntries(checklist.items.map((i) => [i.key, i.checked]));

  const lectureTheoryScore = ((checked.lectures ? 100 : 0) + (checked.theory ? 100 : 0)) / 2;
  const ncertScore = checked.ncert ? 100 : 0;
  const questionsScore = Math.min(safeDiv(stats.qCount, TEST_QUESTION_TARGET_PER_CHAPTER), 1) * 100;
  const accuracyScore = stats.qAccuracy;
  const pyqScore = checked.pyq ? 100 : 0;
  const revisionScore = stats.revisionsDueCount > 0 ? 0 : Math.min(safeDiv(stats.revisionsLogged, REVISION_TARGET), 1) * 100;
  const mistakeScore = stats.qCount === 0 ? 50 : Math.max(0, 100 - stats.mistakeCount * 20);

  const weighted =
    lectureTheoryScore * READINESS_WEIGHTS.lectureTheory +
    ncertScore * READINESS_WEIGHTS.ncert +
    questionsScore * READINESS_WEIGHTS.questions +
    accuracyScore * READINESS_WEIGHTS.accuracy +
    pyqScore * READINESS_WEIGHTS.pyq +
    revisionScore * READINESS_WEIGHTS.revision +
    mistakeScore * READINESS_WEIGHTS.mistake;

  return { readiness: Math.round(weighted / 100), stats, checklist };
}

// Subject readiness across only the chapters a test's syllabus actually
// includes — null (not 0%) when the test has no chapters for that
// subject, so an empty subject never masquerades as "0% ready".
function getSubjectReadiness(chapterIds, tasks, sessions, lectures, resources, questions, revisions, chapterProgress = {}) {
  if (chapterIds.length === 0) return null;
  const scores = chapterIds.map((id) => getChapterReadiness(id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress).readiness);
  return Math.round(scores.reduce((s, x) => s + x, 0) / scores.length);
}

function localDaysBetween(fromISO, toISO) {
  if (!fromISO || !toISO || typeof fromISO !== "string" || typeof toISO !== "string") return 0;
  const [fy, fm, fd] = fromISO.split("-").map(Number);
  const [ty, tm, td] = toISO.split("-").map(Number);
  if (!fy || !fm || !fd || !ty || !tm || !td) return 0;
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

const PREP_MODES = [
  { min: 10, mode: "NORMAL", revisionPct: 60, questionsPct: 40 },
  { min: 7, mode: "TEST PRIORITY", revisionPct: 50, questionsPct: 50 },
  { min: 4, mode: "QUESTION HEAVY", revisionPct: 40, questionsPct: 60 },
  { min: 2, mode: "HEAVY QUESTIONS + REVISION", revisionPct: 28, questionsPct: 72 },
  { min: 1, mode: "RAPID REVISION", revisionPct: 20, questionsPct: 80 },
];
function getPreparationMode(daysRemaining) {
  if (daysRemaining <= 0) return { mode: "RAPID REVISION", revisionPct: 20, questionsPct: 80 }; // test day or past — same as 1-day fallback
  const bucket = PREP_MODES.find((b) => daysRemaining >= b.min) || PREP_MODES[PREP_MODES.length - 1];
  return bucket;
}

/* ------------------------------------------------------------
   TEST ANALYSIS HELPERS — all derived from real Question/
   TestAnalysis/Revision records, nothing fabricated.
   ------------------------------------------------------------ */

// Groups mistake-marked Questions by chapter+mistakeType. A "pattern"
// only counts once it repeats (2+), per spec — never fabricated.
function getRepeatedMistakePatterns(questions) {
  const groups = {};
  questions.filter((q) => q.isMistake).forEach((q) => {
    const chapter = CHAPTERS.find((c) => c.id === q.chapterId);
    const key = `${q.chapterId}|${q.mistakeType}`;
    if (!groups[key]) groups[key] = { chapterName: chapter?.name || "Unlinked", mistakeType: q.mistakeType, count: 0 };
    groups[key].count += 1;
  });
  return Object.values(groups).filter((g) => g.count >= 2).sort((a, b) => b.count - a.count);
}

// Wrong-question performance grouped by chapter, from this test's
// actual TestAnalysis entries only.
function getChapterPerformanceForTest(analysisEntries, questions, tasks, sessions, lectures, resources, allQuestions, revisions, chapterProgress = {}) {
  const groups = {};
  analysisEntries.forEach((a) => {
    const q = questions.find((x) => x.id === a.questionId);
    const chapterId = a.chapterId || q?.chapterId;
    if (!chapterId) return; // question with no chapter — skip safely, never crash
    const chapter = CHAPTERS.find((c) => c.id === chapterId);
    if (!chapter) return;
    if (!groups[chapterId]) groups[chapterId] = { chapter, wrongCount: 0, mistakeCount: 0 };
    groups[chapterId].wrongCount += 1;
    if (q?.isMistake) groups[chapterId].mistakeCount += 1;
  });
  return Object.values(groups).map((g) => {
    const stats = getChapterStats(g.chapter.id, tasks, sessions, lectures, resources, allQuestions, revisions, chapterProgress);
    return { ...g, accuracy: stats.qCount > 0 ? stats.qAccuracy : null, priority: g.wrongCount >= 3 ? "HIGH" : g.wrongCount >= 2 ? "MEDIUM" : "LOW" };
  }).sort((a, b) => b.wrongCount - a.wrongCount);
}

/* ------------------------------------------------------------
   ANALYTICS — every function here is a pure, read-only derivation
   over existing stored records (tasks/sessions/questions/tests/
   revisions). None of them write anything. Dashboard and the
   Analytics page both call these same functions, so there is one
   source of truth for every number shown in either place.
   ------------------------------------------------------------ */

// Sum of StudySession.durationMinutes per local calendar date — the
// single source every streak/heatmap/graph calculation builds on.
function getDailyMinutesMap(sessions) {
  const map = {};
  sessions.forEach((s) => {
    const mins = safeNumber(s.durationMinutes, 0);
    if (mins <= 0 || !s.date) return;
    map[s.date] = (map[s.date] || 0) + mins;
  });
  return map;
}

// An "active day" is a local date with at least one valid session
// whose duration is > 0 — matches STEP 8 §5's definition exactly.
function computeStreaks(dailyMinutesMap) {
  const activeDates = new Set(Object.keys(dailyMinutesMap).filter((d) => dailyMinutesMap[d] > 0));
  if (activeDates.size === 0) return { current: 0, longest: 0 };

  const today = todayISO();
  let current = 0;
  let cursor = today;
  // Walk backward from today; today itself doesn't have to be active
  // yet (the day isn't over), so only start counting once we hit the
  // most recent active day, then keep walking back while consecutive.
  if (!activeDates.has(cursor)) cursor = dateToISO(addDays(new Date(), -1));
  while (activeDates.has(cursor)) {
    current += 1;
    cursor = dateToISO(addDays(new Date(cursor + "T00:00:00"), -1));
  }

  const sortedDates = [...activeDates].sort();
  let longest = 0, run = 0, prev = null;
  sortedDates.forEach((d) => {
    if (prev && localDaysBetween(prev, d) === 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    prev = d;
  });

  return { current, longest: Math.max(longest, current) };
}

// Documented, deterministic heatmap intensity buckets (minutes of
// focused study that local date): 0 → 0, 1–29 → 1, 30–59 → 2,
// 60–119 → 3, 120+ → 4.
function getHeatmapBucket(minutes) {
  if (minutes <= 0) return 0;
  if (minutes < 30) return 1;
  if (minutes < 60) return 2;
  if (minutes < 120) return 3;
  return 4;
}

// Stats for an arbitrary local [fromISO, toISO] date range (inclusive).
// Used for Today/This Week/This Month so Dashboard and Analytics never
// compute the same number two different ways.
function getRangeStats(fromISO, toISO, tasks, sessions, questions, tests) {
  const inRange = (d) => d >= fromISO && d <= toISO;
  const rangeSessions = sessions.filter((s) => inRange(s.date));
  const focusedMinutes = rangeSessions.reduce((s, x) => s + safeNumber(x.durationMinutes, 0), 0);
  const rangeQuestions = questions.filter((q) => inRange(q.dateAdded));
  const correct = rangeQuestions.filter((q) => q.isCorrect === true).length;
  const incorrect = rangeQuestions.filter((q) => q.isCorrect === false).length;
  const rangeTasks = tasks.filter((t) => inRange(t.date));
  const tasksCompleted = rangeTasks.filter((t) => t.status === "COMPLETED").length;
  const testsCompleted = tests.filter((t) => t.status === "Completed" && inRange(t.date)).length;
  return {
    focusedMinutes, sessionsCount: rangeSessions.length,
    questionsCount: rangeQuestions.length, correct, incorrect,
    accuracy: Math.round(safeDiv(correct, correct + incorrect) * 100),
    tasksTotal: rangeTasks.length, tasksCompleted, testsCompleted,
  };
}

function getOverviewStats(tasks, sessions, questions, tests) {
  const focusedMinutes = sessions.reduce((s, x) => s + safeNumber(x.durationMinutes, 0), 0);
  const correct = questions.filter((q) => q.isCorrect === true).length;
  const incorrect = questions.filter((q) => q.isCorrect === false).length;
  const completedTests = tests.filter((t) => t.status === "Completed");
  const avgScore = completedTests.length
    ? Math.round(completedTests.reduce((s, t) => s + safeNumber(t.score, 0), 0) / completedTests.length) : null;
  const { current, longest } = computeStreaks(getDailyMinutesMap(sessions));
  return {
    focusedMinutes, sessionsCount: sessions.length, questionsCount: questions.length,
    accuracy: Math.round(safeDiv(correct, correct + incorrect) * 100),
    testsCompleted: completedTests.length, avgScore, currentStreak: current, longestStreak: longest,
  };
}

// Biology stays a single combined subject, per spec.
function getSubjectAnalytics(subjectId, tasks, sessions, questions, revisions, lectures, resources) {
  const chapterIds = CHAPTERS.filter((c) => c.subjectId === subjectId).map((c) => c.id);
  const subjSessions = sessions.filter((s) => chapterIds.includes(s.chapterId));
  const subjQuestions = questions.filter((q) => q.subjectId === subjectId);
  const focusedMinutes = subjSessions.reduce((s, x) => s + safeNumber(x.durationMinutes, 0), 0);
  const correct = subjQuestions.filter((q) => q.isCorrect === true).length;
  const incorrect = subjQuestions.filter((q) => q.isCorrect === false).length;
  const chaptersStudied = chapterIds.filter((id) =>
    sessions.some((s) => s.chapterId === id) || tasks.some((t) => t.chapterId === id && t.status === "COMPLETED")
  ).length;
  return {
    focusedMinutes, sessionsCount: subjSessions.length, questionsCount: subjQuestions.length,
    correct, incorrect, accuracy: Math.round(safeDiv(correct, correct + incorrect) * 100),
    chaptersStudied, totalChapters: chapterIds.length,
  };
}

// Only chapters with real activity — never pads the list with
// untouched chapters just to show a row.
function getActiveChapterAnalytics(tasks, sessions, lectures, resources, questions, revisions, chapterProgress = {}) {
  return CHAPTERS
    .map((c) => ({ chapter: c, stats: getChapterStats(c.id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress) }))
    .filter(({ stats }) => stats.studyMinutes > 0 || stats.qCount > 0 || stats.lastStudied)
    .sort((a, b) => b.stats.studyMinutes - a.stats.studyMinutes);
}

function getMistakeTypeDistribution(questions) {
  const counts = {};
  questions.filter((q) => q.isMistake).forEach((q) => { counts[q.mistakeType] = (counts[q.mistakeType] || 0) + 1; });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

// Only meaningful with 2+ completed tests — never invents a trend line.
function getTestScoreTrend(tests) {
  const completed = tests.filter((t) => t.status === "Completed" && t.score != null).sort((a, b) => a.date.localeCompare(b.date));
  return completed.length >= 2 ? completed.map((t) => ({ date: t.date, name: t.name, score: t.score })) : [];
}

function getTestAnalyticsSummary(tests) {
  const completed = tests.filter((t) => t.status === "Completed");
  if (completed.length === 0) return null;
  const scores = completed.map((t) => safeNumber(t.score, 0));
  const accuracies = completed.filter((t) => t.accuracy != null).map((t) => t.accuracy);
  return {
    count: completed.length,
    avgScore: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length),
    bestScore: Math.max(...scores),
    lowestScore: Math.min(...scores),
    avgAccuracy: accuracies.length ? Math.round(accuracies.reduce((s, x) => s + x, 0) / accuracies.length) : null,
    trend: getTestScoreTrend(tests),
  };
}

/* ------------------------------------------------------------
   BACKLOG — derived entirely from the existing Task entity; there
   is no separate BacklogItem record. A task IS a backlog item
   exactly when its scheduled date is in the past, it isn't
   completed, and it isn't cancelled. Rescheduling/completing/
   cancelling a backlog row just patches the same Task — nothing
   here ever creates a second record.
   ------------------------------------------------------------ */

function isBacklogTask(task, today) {
  return task.date < today && task.status !== "COMPLETED" && task.status !== "CANCELLED";
}
function getBacklogTasks(tasks) {
  const today = todayISO();
  return tasks.filter((t) => isBacklogTask(t, today));
}

// Ranking is display-only — it never reorders or reschedules anything.
function rankBacklogTasks(backlogTasks, today) {
  return [...backlogTasks].sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    const overdueDiff = localDaysBetween(a.date, today) - localDaysBetween(b.date, today);
    if (overdueDiff !== 0) return -overdueDiff; // more overdue first
    return safeNumber(b.estimatedMinutes, 0) - safeNumber(a.estimatedMinutes, 0);
  });
}

function getBacklogStats(tasks) {
  const today = todayISO();
  const backlog = getBacklogTasks(tasks);
  const buckets = { day1: 0, days1to3: 0, days4to7: 0, days8plus: 0 };
  backlog.forEach((t) => {
    const days = localDaysBetween(t.date, today);
    if (days <= 1) buckets.day1 += 1;
    else if (days <= 3) buckets.days1to3 += 1;
    else if (days <= 7) buckets.days4to7 += 1;
    else buckets.days8plus += 1;
  });
  // A task "completed from backlog" is one that was finished on a day
  // after its own scheduled date — i.e. it sat overdue before being done.
  const completedFromBacklog = tasks.filter((t) => t.status === "COMPLETED" && t.completedAt && dateToISO(new Date(t.completedAt)) > t.date).length;
  const oldest = [...backlog].sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  return { count: backlog.length, buckets, completedFromBacklog, oldest };
}

const STATUS_LABEL = {
  NOT_STARTED: "Not started", IN_PROGRESS: "In progress", LECTURES_COMPLETED: "Lectures done",
  FIRST_STUDY_COMPLETED: "First study done", REVISION_DUE: "Revision due", WEAK: "Weak",
  STRONG: "Strong", MASTERED: "Mastered",
};
const STATUS_TONE = {
  NOT_STARTED: "neutral", IN_PROGRESS: "medium", LECTURES_COMPLETED: "medium",
  FIRST_STUDY_COMPLETED: "high", REVISION_DUE: "high", WEAK: "critical",
  STRONG: "done", MASTERED: "done",
};

function formatDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null; // guard against a malformed/partial date string rather than showing "Invalid Date"
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

/* ------------------------------------------------------------
   PERSISTENCE LAYER — the only code in this file allowed to
   touch window.storage. Swappable for a real DB later without
   touching any component below.
   ------------------------------------------------------------ */

const DEFAULT_SETTINGS = { dailyCapacityMinutes: 480, theme: "dark", autoRevisionEnabled: true, revisionIntervals: { physics: [1,3,7,14,30], chemistry: [1,3,7,14,30], biology: [1,3,7,14,30] }, revisionDurations: { physics: 45, chemistry: 45, biology: 30 }, prepBaseline: null };

const STORE_KEYS = {
  tasks: "tasks",
  sessions: "study_sessions",
  events: "calendar_events",
  dailyPlans: "daily_plans",
  settings: "settings",
  chapterProgress: "chapter_progress", // manual (non-derivable) checklist flags, keyed by chapterId
  resources: "resources",
  lectures: "lectures",
  activeTimer: "active_timer", // survives navigation/reload — see TimerProvider
  dailyCheckins: "daily_checkins", // {date: hoursNumber} — asked once per day
  questions: "questions",
  revisions: "revisions",
  tests: "tests",
  testSyllabus: "test_syllabus",
  testAnalysis: "test_analysis",
  weeklyReviews: "weekly_reviews", // { [weekStartISO]: { wentWell, wentWrong, focusNext } }
};

async function storageGet(key, fallback) {
  try {
    if (typeof window === "undefined" || !window.storage || typeof window.storage.get !== "function") {
      return fallback;
    }
    const res = await window.storage.get(key, false);
    if (!res || res.value == null || res.value === "") return fallback;
    const parsed = JSON.parse(res.value);
    // JSON "null" parses to null — treat as missing so callers always get a usable shape
    if (parsed === null || parsed === undefined) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}
async function storageSet(key, value) {
  try {
    if (typeof window === "undefined" || !window.storage || typeof window.storage.set !== "function") return;
    await window.storage.set(key, JSON.stringify(value), false);
  } catch {
    /* best-effort; UI already holds the value in state */
  }
}

const repo = {
  async loadAll() {
    const [tasks, sessions, events, dailyPlans, settings, chapterProgress, resources, lectures, activeTimer, dailyCheckins, questions, revisions, tests, testSyllabus, testAnalysis, weeklyReviews] = await Promise.all([
      storageGet(STORE_KEYS.tasks, []),
      storageGet(STORE_KEYS.sessions, []),
      storageGet(STORE_KEYS.events, []),
      storageGet(STORE_KEYS.dailyPlans, []),
      storageGet(STORE_KEYS.settings, { ...DEFAULT_SETTINGS }),
      storageGet(STORE_KEYS.chapterProgress, {}),
      storageGet(STORE_KEYS.resources, []),
      storageGet(STORE_KEYS.lectures, []),
      storageGet(STORE_KEYS.activeTimer, null),
      storageGet(STORE_KEYS.dailyCheckins, {}),
      storageGet(STORE_KEYS.questions, []),
      storageGet(STORE_KEYS.revisions, []),
      storageGet(STORE_KEYS.tests, []),
      storageGet(STORE_KEYS.testSyllabus, []),
      storageGet(STORE_KEYS.testAnalysis, []),
      storageGet(STORE_KEYS.weeklyReviews, {}),
    ]);
    return { tasks, sessions, events, dailyPlans, settings, chapterProgress, resources, lectures, activeTimer, dailyCheckins, questions, revisions, tests, testSyllabus, testAnalysis, weeklyReviews };
  },
  saveTasks: (tasks) => storageSet(STORE_KEYS.tasks, tasks),
  saveSessions: (sessions) => storageSet(STORE_KEYS.sessions, sessions),
  saveEvents: (events) => storageSet(STORE_KEYS.events, events),
  saveDailyPlans: (plans) => storageSet(STORE_KEYS.dailyPlans, plans),
  saveSettings: (settings) => storageSet(STORE_KEYS.settings, settings),
  saveChapterProgress: (cp) => storageSet(STORE_KEYS.chapterProgress, cp),
  saveResources: (resources) => storageSet(STORE_KEYS.resources, resources),
  saveLectures: (lectures) => storageSet(STORE_KEYS.lectures, lectures),
  saveActiveTimer: (t) => storageSet(STORE_KEYS.activeTimer, t),
  saveDailyCheckins: (c) => storageSet(STORE_KEYS.dailyCheckins, c),
  saveQuestions: (q) => storageSet(STORE_KEYS.questions, q),
  saveRevisions: (r) => storageSet(STORE_KEYS.revisions, r),
  saveTests: (t) => storageSet(STORE_KEYS.tests, t),
  saveTestSyllabus: (s) => storageSet(STORE_KEYS.testSyllabus, s),
  saveTestAnalysis: (a) => storageSet(STORE_KEYS.testAnalysis, a),
  saveWeeklyReviews: (w) => storageSet(STORE_KEYS.weeklyReviews, w),
};

/* ------------------------------------------------------------
   BACKUP — full JSON export/import + CSV export. Export/import
   never touch the live app state directly; they build/parse plain
   objects, and only Import's explicit Merge/Replace step writes
   through the same repo.save* functions above (Cancel writes nothing).
   ------------------------------------------------------------ */

const SCHEMA_VERSION = 1;
const ARRAY_ENTITY_KEYS = ["tasks", "sessions", "events", "dailyPlans", "resources", "lectures", "questions", "revisions", "tests", "testSyllabus", "testAnalysis"];
const OBJECT_ENTITY_KEYS = ["settings", "chapterProgress", "dailyCheckins", "weeklyReviews"];

function buildExportPayload(data) {
  const payload = { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), app: "NEET Preparation OS" };
  ARRAY_ENTITY_KEYS.concat(OBJECT_ENTITY_KEYS).forEach((k) => { payload[k] = data[k]; });
  return payload;
}

function downloadTextFile(filename, content, mime) {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

// Validates structure ONLY — never mutates anything. Returns
// { ok, errors } or { ok:true, data, normalizedCount }.
function validateImportPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${e.message}`] };
  }
  const errors = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["Root of the file must be a JSON object."] };
  }
  if (Object.keys(parsed).length === 0) errors.push("File is an empty object — nothing to import.");
  if (parsed.schemaVersion !== SCHEMA_VERSION) errors.push(`Unsupported schemaVersion (expected ${SCHEMA_VERSION}, found ${JSON.stringify(parsed.schemaVersion)}).`);
  ARRAY_ENTITY_KEYS.forEach((k) => {
    if (parsed[k] !== undefined && !Array.isArray(parsed[k])) errors.push(`"${k}" must be an array.`);
  });
  OBJECT_ENTITY_KEYS.forEach((k) => {
    if (parsed[k] !== undefined && (typeof parsed[k] !== "object" || Array.isArray(parsed[k]))) errors.push(`"${k}" must be an object.`);
  });
  if (errors.length > 0) return { ok: false, errors };

  // Safely normalize (never silently keep) broken chapter/subject references.
  let normalizedCount = 0;
  const knownChapterIds = new Set(CHAPTERS.map((c) => c.id));
  const knownSubjectIds = new Set(SUBJECTS.map((s) => s.id));
  function normalizeRefs(arr, chapterField, subjectField) {
    if (!Array.isArray(arr)) return arr;
    return arr.map((rec) => {
      let r = rec;
      if (chapterField && r[chapterField] && !knownChapterIds.has(r[chapterField])) { r = { ...r, [chapterField]: "" }; normalizedCount++; }
      if (subjectField && r[subjectField] && !knownSubjectIds.has(r[subjectField])) { r = { ...r, [subjectField]: "" }; normalizedCount++; }
      return r;
    });
  }
  const data = { ...parsed };
  data.tasks = normalizeRefs(data.tasks || [], "chapterId", "subjectId");
  data.resources = normalizeRefs(data.resources || [], "chapterId", "subjectId");
  data.lectures = normalizeRefs(data.lectures || [], "chapterId", null);
  data.questions = normalizeRefs(data.questions || [], "chapterId", "subjectId");
  data.testSyllabus = normalizeRefs(data.testSyllabus || [], "chapterId", "subjectId");
  ARRAY_ENTITY_KEYS.forEach((k) => { if (data[k] === undefined) data[k] = []; });
  OBJECT_ENTITY_KEYS.forEach((k) => { if (data[k] === undefined) data[k] = {}; });

  return { ok: true, data, normalizedCount };
}

// Upsert-by-id merge: existing records are kept; imported records with
// a matching id overwrite that record, new ids are appended.
function mergeArraysById(existing, imported) {
  const map = new Map(existing.map((r) => [r.id, r]));
  imported.forEach((r) => { if (r && r.id) map.set(r.id, { ...map.get(r.id), ...r }); });
  return [...map.values()];
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function toCSV(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => csvEscape(c.get(row))).join(","));
  return [header, ...lines].join("\r\n");
}

/* ------------------------------------------------------------
   APP DATA CONTEXT — central store; UI components never touch
   storage directly, only these actions.
   ------------------------------------------------------------ */

const AppDataContext = createContext(null);
function useAppData() {
  return useContext(AppDataContext);
}

function AppDataProvider({ children }) {
  const [loaded, setLoaded] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [dailyPlans, setDailyPlans] = useState([]);
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS }));
  const [chapterProgress, setChapterProgress] = useState({});
  const [resources, setResources] = useState([]);
  const [lectures, setLectures] = useState([]);
  const [dailyCheckins, setDailyCheckins] = useState({});
  const [questions, setQuestions] = useState([]);
  const [revisions, setRevisions] = useState([]);
  const [tests, setTests] = useState([]);
  const [testSyllabus, setTestSyllabus] = useState([]);
  const [testAnalysis, setTestAnalysis] = useState([]);
  const [weeklyReviews, setWeeklyReviews] = useState({});
  const [initialActiveTimer, setInitialActiveTimer] = useState(null);

  useEffect(() => {
    let cancelled = false;
    repo.loadAll().then((data) => {
      if (cancelled) return;
      // Normalize shapes — corrupted/null storage must never leave state non-iterable
      // or non-object (that would crash first Dashboard render after load).
      const asArr = (v) => (Array.isArray(v) ? v : []);
      const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
      setTasks(asArr(data.tasks));
      setSessions(asArr(data.sessions));
      setEvents(asArr(data.events));
      setDailyPlans(asArr(data.dailyPlans));
      setSettings({ ...DEFAULT_SETTINGS, ...asObj(data.settings) });
      setChapterProgress(asObj(data.chapterProgress));
      setResources(asArr(data.resources));
      setLectures(asArr(data.lectures));
      setDailyCheckins(asObj(data.dailyCheckins));
      setQuestions(asArr(data.questions));
      setRevisions(asArr(data.revisions));
      setTests(asArr(data.tests));
      setTestSyllabus(asArr(data.testSyllabus));
      setTestAnalysis(asArr(data.testAnalysis));
      setWeeklyReviews(asObj(data.weeklyReviews));
      const timer = data.activeTimer;
      setInitialActiveTimer(timer && typeof timer === "object" ? timer : null);
      setLoaded(true);
    }).catch((err) => {
      console.error("NEET Prep OS: failed to load persisted data", err);
      if (!cancelled) setLoaded(true); // still show UI with empty defaults
    });
    return () => { cancelled = true; };
  }, []);

  const createTask = useCallback((partial) => {
    const task = makeTask(partial);
    setTasks((prev) => {
      const next = [...prev, task];
      repo.saveTasks(next);
      return next;
    });
    // Calendar and Dashboard both read from this same tasks array,
    // so a dated task appears on its date with no separate write.
    return task;
  }, []);

  const updateTask = useCallback((id, patch) => {
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
      repo.saveTasks(next);
      return next;
    });
  }, []);

  /* ---------- Automatic Spaced Revision Engine (chapter-level) ---------- */

  // B8 invariant: only one active automatic chain per chapter — if ANY
  // Chapter Revision record already exists for it, never start a second.
  const startChapterRevisionChain = useCallback((chapterId) => {
    const chapter = CHAPTERS.find((c) => c.id === chapterId);
    if (!chapter) return;
    const chainExists = revisions.some((r) => r.targetType === "chapter" && r.targetId === chapterId && r.revisionType === "Chapter Revision");
    if (chainExists) return;
    // Historical revision progress means the chapter already has R-progress —
    // do not restart the automatic chain at R1 from a first-study completion.
    const histRev = getHistoricalState(chapterId, chapterProgress)?.revisionCount;
    if (histRev != null && safeNumber(histRev, 0) > 0) return;
    const scheduledDate = dateToISO(addDays(new Date(), intervalForSubjectRevision(chapter.subjectId, 1, settings)));
    const revision = makeRevision({ targetType: "chapter", targetId: chapterId, revisionType: "Chapter Revision", revisionNumber: 1, scheduledDate, status: "SCHEDULED" });
    setRevisions((prev) => { const next = [...prev, revision]; repo.saveRevisions(next); return next; });
    const task = makeTask({
      title: `Revision — ${chapter.name} R1`, subjectId: chapter.subjectId,
      subject: SUBJECTS.find((s) => s.id === chapter.subjectId)?.name || "", chapterId,
      type: "REVISION", priority: "MEDIUM", date: scheduledDate,
      estimatedMinutes: getSubjectRevisionDuration(chapter.subjectId, settings),
      revisionId: revision.id,
    });
    setTasks((prev) => { const next = [...prev, task]; repo.saveTasks(next); return next; });
  }, [revisions, settings, chapterProgress]);

  // Advances exactly one step: completes the given Revision and creates
  // exactly the NEXT Revision + its linked Task — never the whole chain.
  const advanceChapterRevisionCycle = useCallback((revisionId) => {
    const rev = revisions.find((r) => r.id === revisionId);
    if (!rev || rev.status === "COMPLETED" || rev.targetType !== "chapter") return;
    const chapter = CHAPTERS.find((c) => c.id === rev.targetId);
    if (!chapter) return;
    const today = todayISO();
    const nextNumber = rev.revisionNumber + 1;
    const nextDate = dateToISO(addDays(new Date(), intervalForSubjectRevision(chapter.subjectId, nextNumber, settings)));
    // B8: only one scheduled/completed Revision per target+revisionNumber.
    const dupExists = revisions.some((r) => r.targetType === "chapter" && r.targetId === rev.targetId && r.revisionType === "Chapter Revision" && r.revisionNumber === nextNumber);
    const nextRevision = dupExists ? null : makeRevision({ targetType: "chapter", targetId: rev.targetId, revisionType: "Chapter Revision", revisionNumber: nextNumber, scheduledDate: nextDate, status: "SCHEDULED" });

    setRevisions((prev) => {
      const updated = prev.map((r) => (r.id === revisionId ? { ...r, status: "COMPLETED", completedDate: today } : r));
      const next = nextRevision ? [...updated, nextRevision] : updated;
      repo.saveRevisions(next);
      return next;
    });

    if (nextRevision) {
      setTasks((prev) => {
        // B8: only one Task may carry this new Revision's id.
        if (prev.some((t) => t.revisionId === nextRevision.id)) return prev;
        const next = [...prev, makeTask({
          title: `Revision — ${chapter.name} R${nextNumber}`, subjectId: chapter.subjectId,
          subject: SUBJECTS.find((s) => s.id === chapter.subjectId)?.name || "", chapterId: chapter.id,
          type: "REVISION", priority: "MEDIUM", date: nextDate,
          estimatedMinutes: getSubjectRevisionDuration(chapter.subjectId, settings),
          revisionId: nextRevision.id,
        })];
        repo.saveTasks(next);
        return next;
      });
    }
  }, [revisions, settings]);

  // B16 — recovers a Task for a Revision whose linked Task was deleted.
  // Creates exactly one Task; never creates another Revision.
  const regenerateRevisionTask = useCallback((revisionId) => {
    setTasks((prevTasks) => {
      if (prevTasks.some((t) => t.revisionId === revisionId)) return prevTasks; // already has one — never duplicate
      const rev = revisions.find((r) => r.id === revisionId);
      if (!rev) return prevTasks;
      const chapter = CHAPTERS.find((c) => c.id === rev.targetId);
      if (!chapter) return prevTasks;
      const next = [...prevTasks, makeTask({
        title: `Revision — ${chapter.name} R${rev.revisionNumber}`, subjectId: chapter.subjectId,
        subject: SUBJECTS.find((s) => s.id === chapter.subjectId)?.name || "", chapterId: chapter.id,
        type: "REVISION", priority: "MEDIUM", date: rev.scheduledDate,
        estimatedMinutes: getSubjectRevisionDuration(chapter.subjectId, settings),
        revisionId: rev.id,
      })];
      repo.saveTasks(next);
      return next;
    });
  }, [revisions, settings]);

  // B17 — explicit reschedule keeps Task.date and Revision.scheduledDate
  // in sync; never touches anything else, never auto-fires on its own.
  const rescheduleTask = useCallback((taskId, newDate) => {
    const task = tasks.find((t) => t.id === taskId);
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === taskId ? { ...t, date: newDate } : t));
      repo.saveTasks(next);
      return next;
    });
    if (task?.revisionId) {
      setRevisions((prev) => {
        const next = prev.map((r) => (r.id === task.revisionId ? { ...r, scheduledDate: newDate } : r));
        repo.saveRevisions(next);
        return next;
      });
    }
  }, [tasks]);

  const completeTask = useCallback((id) => {
    const task = tasks.find((t) => t.id === id);
    setTasks((prev) => {
      const next = prev.map((t) =>
        t.id === id
          ? { ...t, status: "COMPLETED", completedAt: new Date().toISOString(),
              actualMinutes: t.actualMinutes || t.estimatedMinutes }
          : t
      );
      repo.saveTasks(next);
      return next;
    });
    // Guard against double-clicks/repeated calls re-triggering the chain:
    // only act if this task wasn't already completed before this call.
    if (!task || task.status === "COMPLETED") return;
    if (task.revisionId) {
      advanceChapterRevisionCycle(task.revisionId);
    } else if (task.countsAsFirstStudy && task.chapterId && settings.autoRevisionEnabled !== false) {
      startChapterRevisionChain(task.chapterId);
    }
  }, [tasks, settings, advanceChapterRevisionCycle, startChapterRevisionChain]);

  const deleteTask = useCallback((id) => {
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      repo.saveTasks(next);
      return next;
    });
  }, []);

  const createSession = useCallback((partial) => {
    const cleaned = {
      ...partial,
      durationMinutes: Math.max(0, safeNumber(partial?.durationMinutes, 0)),
    };
    const session = makeStudySession(cleaned);
    setSessions((prev) => {
      const next = [...prev, session];
      repo.saveSessions(next);
      return next;
    });
    return session;
  }, []);

  const updateSession = useCallback((id, patch) => {
    setSessions((prev) => {
      const cleaned = patch && patch.durationMinutes !== undefined
        ? { ...patch, durationMinutes: Math.max(0, safeNumber(patch.durationMinutes, 0)) }
        : patch;
      const next = prev.map((s) => (s.id === id ? { ...s, ...cleaned } : s));
      repo.saveSessions(next);
      return next;
    });
  }, []);

  const deleteSession = useCallback((id) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      repo.saveSessions(next);
      return next;
    });
  }, []);

  const updateSettings = useCallback((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      repo.saveSettings(next);
      return next;
    });
  }, []);

  const updateChapterProgress = useCallback((chapterId, patch) => {
    setChapterProgress((prev) => {
      const next = { ...prev, [chapterId]: { ...(prev[chapterId] || {}), ...patch } };
      repo.saveChapterProgress(next);
      return next;
    });
  }, []);

  // Historical chapter state only — never creates live Sessions/Questions/Tasks/Revisions.
  const setChapterHistorical = useCallback((chapterId, historical) => {
    setChapterProgress((prev) => {
      const cur = prev[chapterId] || {};
      const next = { ...prev, [chapterId]: { ...cur, historical: historical || null } };
      repo.saveChapterProgress(next);
      return next;
    });
  }, []);

  const clearAllHistoricalBaseline = useCallback(() => {
    setSettings((prev) => {
      const next = { ...prev, prepBaseline: null };
      repo.saveSettings(next);
      return next;
    });
    setChapterProgress((prev) => {
      const next = {};
      Object.keys(prev).forEach((id) => {
        const entry = prev[id] || {};
        const { historical, ...rest } = entry;
        if (Object.keys(rest).length > 0) next[id] = rest;
      });
      repo.saveChapterProgress(next);
      return next;
    });
  }, []);

  const setWeeklyReview = useCallback((weekStart, patch) => {
    setWeeklyReviews((prev) => {
      const next = { ...prev, [weekStart]: { ...(prev[weekStart] || {}), ...patch, weekStart, updatedAt: new Date().toISOString() } };
      repo.saveWeeklyReviews(next);
      return next;
    });
  }, []);

  const createResource = useCallback((partial) => {
    const resource = makeResource(partial);
    setResources((prev) => {
      const next = [...prev, resource];
      repo.saveResources(next);
      return next;
    });
    return resource;
  }, []);

  const updateResource = useCallback((id, patch) => {
    setResources((prev) => {
      const next = prev.map((r) => (r.id === id ? { ...r, ...patch, updatedAt: new Date().toISOString() } : r));
      repo.saveResources(next);
      return next;
    });
  }, []);

  const deleteResource = useCallback((id) => {
    setResources((prev) => {
      const next = prev.filter((r) => r.id !== id);
      repo.saveResources(next);
      return next;
    });
    setLectures((prev) => {
      const next = prev.filter((l) => l.resourceId !== id);
      repo.saveLectures(next);
      return next;
    });
  }, []);

  const createLecture = useCallback((partial) => {
    const lecture = makeLecture(partial);
    setLectures((prev) => {
      const next = [...prev, lecture];
      repo.saveLectures(next);
      return next;
    });
    return lecture;
  }, []);

  const updateLecture = useCallback((id, patch) => {
    setLectures((prev) => {
      const next = prev.map((l) => (l.id === id ? { ...l, ...patch } : l));
      repo.saveLectures(next);
      return next;
    });
  }, []);

  const deleteLecture = useCallback((id) => {
    setLectures((prev) => {
      const next = prev.filter((l) => l.id !== id);
      repo.saveLectures(next);
      return next;
    });
  }, []);

  const setDailyCheckin = useCallback((date, hours) => {
    setDailyCheckins((prev) => {
      const next = { ...prev, [date]: safeNumber(hours, 0) };
      repo.saveDailyCheckins(next);
      return next;
    });
  }, []);

  /* ---------- Question / Important / Mistake / Revision ---------- */

  // Revision helpers — functional setState only, so they're stable
  // across renders and safe to call from other callbacks below.
  const createRevisionIfAbsent = useCallback((targetId, targetType, revisionType) => {
    setRevisions((prev) => {
      const exists = prev.some((r) => r.targetId === targetId && r.targetType === targetType && r.revisionType === revisionType && r.status === "SCHEDULED");
      if (exists) return prev;
      const next = [...prev, makeRevision({
        targetType, targetId, revisionType, revisionNumber: 1,
        scheduledDate: dateToISO(addDays(new Date(), intervalForRevisionNumber(1))),
        status: "SCHEDULED",
      })];
      repo.saveRevisions(next);
      return next;
    });
  }, []);

  const removeScheduledRevisions = useCallback((targetId, targetType, revisionType) => {
    setRevisions((prev) => {
      const next = prev.filter((r) => !(r.targetId === targetId && r.targetType === targetType && r.revisionType === revisionType && r.status === "SCHEDULED"));
      repo.saveRevisions(next);
      return next;
    });
  }, []);

  const createQuestion = useCallback((partial) => {
    // Data safety: reject malformed references rather than silently creating them.
    if (!partial.questionText || !partial.questionText.trim() || !partial.subjectId || !partial.chapterId) return null;
    const q = makeQuestion(partial);
    setQuestions((prev) => {
      const next = [...prev, q];
      repo.saveQuestions(next);
      return next;
    });
    if (q.isImportant) createRevisionIfAbsent(q.id, "question", "Important Question");
    if (q.isMistake) createRevisionIfAbsent(q.id, "question", "Mistake");
    return q;
  }, [createRevisionIfAbsent]);

  const updateQuestion = useCallback((id, patch) => {
    setQuestions((prev) => {
      const next = prev.map((q) => (q.id === id ? { ...q, ...patch } : q));
      repo.saveQuestions(next);
      return next;
    });
  }, []);

  const deleteQuestion = useCallback((id) => {
    setQuestions((prev) => {
      const next = prev.filter((q) => q.id !== id);
      repo.saveQuestions(next);
      return next;
    });
    // Never leave orphan revisions pointing at a deleted question.
    setRevisions((prev) => {
      const next = prev.filter((r) => !(r.targetType === "question" && r.targetId === id));
      repo.saveRevisions(next);
      return next;
    });
    // Test analysis rows referencing this question are handled gracefully at
    // render time even without this, but drop them too rather than leaving
    // silent zombie records around.
    setTestAnalysis((prev) => {
      const next = prev.filter((a) => a.questionId !== id);
      repo.saveTestAnalysis(next);
      return next;
    });
  }, []);

  const setImportant = useCallback((id, val) => {
    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (q.id !== id) return q;
        return val
          ? { ...q, isImportant: true }
          : { ...q, isImportant: false, importantTags: [], importantRevisionCount: 0, importantLastRevised: "", importantNextRevision: "" };
      });
      repo.saveQuestions(next);
      return next;
    });
    if (val) createRevisionIfAbsent(id, "question", "Important Question");
    else removeScheduledRevisions(id, "question", "Important Question");
  }, [createRevisionIfAbsent, removeScheduledRevisions]);

  const setMistake = useCallback((id, val, meta = {}) => {
    setQuestions((prev) => {
      const next = prev.map((q) => {
        if (q.id !== id) return q;
        return val
          ? { ...q, isMistake: true, mistakeType: meta.mistakeType || q.mistakeType || "Conceptual", mistakeNotes: meta.mistakeNotes ?? q.mistakeNotes, correctApproach: meta.correctApproach ?? q.correctApproach }
          : { ...q, isMistake: false, mistakeType: "", mistakeNotes: "", correctApproach: "", mistakeRevisionCount: 0, mistakeLastRevised: "", mistakeNextRevision: "" };
      });
      repo.saveQuestions(next);
      return next;
    });
    if (val) createRevisionIfAbsent(id, "question", "Mistake");
    else removeScheduledRevisions(id, "question", "Mistake");
  }, [createRevisionIfAbsent, removeScheduledRevisions]);

  const createRevision = useCallback((partial) => {
    const r = makeRevision(partial);
    setRevisions((prev) => {
      const next = [...prev, r];
      repo.saveRevisions(next);
      return next;
    });
    return r;
  }, []);

  const completeRevision = useCallback((revisionId) => {
    const rev = revisions.find((r) => r.id === revisionId);
    if (!rev || rev.status === "COMPLETED") return;
    const today = todayISO();
    const nextNumber = rev.revisionNumber + 1;
    const nextDate = dateToISO(addDays(new Date(), intervalForRevisionNumber(nextNumber)));

    setRevisions((prev) => {
      const updated = prev.map((r) => (r.id === revisionId ? { ...r, status: "COMPLETED", completedDate: today } : r));
      const dupExists = updated.some((r) =>
        r.targetType === rev.targetType && r.targetId === rev.targetId &&
        r.revisionType === rev.revisionType && r.revisionNumber === nextNumber && r.status === "SCHEDULED");
      const next = dupExists ? updated : [...updated, makeRevision({
        targetType: rev.targetType, targetId: rev.targetId, revisionType: rev.revisionType,
        revisionNumber: nextNumber, scheduledDate: nextDate, status: "SCHEDULED",
      })];
      repo.saveRevisions(next);
      return next;
    });

    if (rev.targetType === "question") {
      setQuestions((prev) => {
        const next = prev.map((q) => {
          if (q.id !== rev.targetId) return q;
          if (rev.revisionType === "Important Question") {
            return { ...q, importantRevisionCount: (q.importantRevisionCount || 0) + 1, importantLastRevised: today, importantNextRevision: nextDate };
          }
          if (rev.revisionType === "Mistake") {
            return { ...q, mistakeRevisionCount: (q.mistakeRevisionCount || 0) + 1, mistakeLastRevised: today, mistakeNextRevision: nextDate };
          }
          return q;
        });
        repo.saveQuestions(next);
        return next;
      });
    }
  }, [revisions]);

  /* ---------- Test / TestSyllabus / TestAnalysis ---------- */

  const createTest = useCallback((partial) => {
    if (!partial.name || !partial.name.trim()) return null;
    const t = makeTest(partial);
    setTests((prev) => { const next = [...prev, t]; repo.saveTests(next); return next; });
    return t;
  }, []);

  const updateTest = useCallback((id, patch) => {
    setTests((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
      repo.saveTests(next);
      return next;
    });
  }, []);

  // Deletes the Test and its own syllabus/analysis links only — never
  // touches Questions, Sessions, Chapters, Tasks, or Revisions.
  const deleteTest = useCallback((id) => {
    setTests((prev) => { const next = prev.filter((t) => t.id !== id); repo.saveTests(next); return next; });
    setTestSyllabus((prev) => { const next = prev.filter((s) => s.testId !== id); repo.saveTestSyllabus(next); return next; });
    setTestAnalysis((prev) => { const next = prev.filter((a) => a.testId !== id); repo.saveTestAnalysis(next); return next; });
  }, []);

  const setTestResult = useCallback((id, result) => {
    const correct = Math.max(0, safeNumber(result.correct, 0));
    const wrong = Math.max(0, safeNumber(result.wrong, 0));
    const unattempted = Math.max(0, safeNumber(result.unattempted, 0));
    const accuracy = Math.round(safeDiv(correct, correct + wrong) * 100);
    updateTest(id, {
      status: "Completed", correct, wrong, unattempted, accuracy,
      score: safeNumber(result.score, correct * 4 - wrong),
      subjectScores: {
        physics: result.subjectScores?.physics === "" || result.subjectScores?.physics == null ? null : safeNumber(result.subjectScores.physics),
        chemistry: result.subjectScores?.chemistry === "" || result.subjectScores?.chemistry == null ? null : safeNumber(result.subjectScores.chemistry),
        biology: result.subjectScores?.biology === "" || result.subjectScores?.biology == null ? null : safeNumber(result.subjectScores.biology),
      },
    });
  }, [updateTest]);

  const addTestSyllabusEntry = useCallback((partial) => {
    setTestSyllabus((prev) => {
      const dup = prev.some((s) => s.testId === partial.testId && s.chapterId === partial.chapterId && s.topicId === (partial.topicId || ""));
      if (dup) return prev;
      const next = [...prev, makeTestSyllabusEntry(partial)];
      repo.saveTestSyllabus(next);
      return next;
    });
  }, []);

  const removeTestSyllabusEntry = useCallback((id) => {
    setTestSyllabus((prev) => { const next = prev.filter((s) => s.id !== id); repo.saveTestSyllabus(next); return next; });
  }, []);

  const createTestAnalysis = useCallback((partial) => {
    // Prevent duplicate analysis links for the same question on the same test.
    const existing = testAnalysis.find((a) => a.testId === partial.testId && a.questionId === partial.questionId);
    if (existing) return existing;
    const a = makeTestAnalysis(partial);
    setTestAnalysis((prev) => { const next = [...prev, a]; repo.saveTestAnalysis(next); return next; });
    return a;
  }, [testAnalysis]);

  const linkTestAnalysisTask = useCallback((analysisId, taskId) => {
    setTestAnalysis((prev) => {
      const next = prev.map((a) => (a.id === analysisId ? { ...a, taskId } : a));
      repo.saveTestAnalysis(next);
      return next;
    });
  }, []);

  /* ---------- Full backup import (Merge/Replace) ----------
     Cancel never calls this at all, so it writes nothing. Both
     modes write through the same repo.save* functions everything
     else uses — no separate mutation path. */
  const importData = useCallback((data, mode) => {
    const setAndSave = (setter, saver, existing, imported) => {
      const next = mode === "replace" ? imported : mergeArraysById(existing, imported);
      setter(next);
      saver(next);
    };
    setAndSave(setTasks, repo.saveTasks, tasks, data.tasks);
    setAndSave(setSessions, repo.saveSessions, sessions, data.sessions);
    setAndSave(setEvents, repo.saveEvents, events, data.events);
    setAndSave(setDailyPlans, repo.saveDailyPlans, dailyPlans, data.dailyPlans);
    setAndSave(setResources, repo.saveResources, resources, data.resources);
    setAndSave(setLectures, repo.saveLectures, lectures, data.lectures);
    setAndSave(setQuestions, repo.saveQuestions, questions, data.questions);
    setAndSave(setRevisions, repo.saveRevisions, revisions, data.revisions);
    setAndSave(setTests, repo.saveTests, tests, data.tests);
    setAndSave(setTestSyllabus, repo.saveTestSyllabus, testSyllabus, data.testSyllabus);
    setAndSave(setTestAnalysis, repo.saveTestAnalysis, testAnalysis, data.testAnalysis);

    const nextSettings = mode === "replace" ? data.settings : { ...settings, ...data.settings };
    setSettings(nextSettings); repo.saveSettings(nextSettings);
    const nextChapterProgress = mode === "replace" ? data.chapterProgress : { ...chapterProgress, ...data.chapterProgress };
    setChapterProgress(nextChapterProgress); repo.saveChapterProgress(nextChapterProgress);
    const nextCheckins = mode === "replace" ? data.dailyCheckins : { ...dailyCheckins, ...data.dailyCheckins };
    setDailyCheckins(nextCheckins); repo.saveDailyCheckins(nextCheckins);
    const nextWeekly = mode === "replace" ? (data.weeklyReviews || {}) : { ...weeklyReviews, ...(data.weeklyReviews || {}) };
    setWeeklyReviews(nextWeekly); repo.saveWeeklyReviews(nextWeekly);
  }, [tasks, sessions, events, dailyPlans, resources, lectures, questions, revisions, tests, testSyllabus, testAnalysis, settings, chapterProgress, dailyCheckins, weeklyReviews]);

  const value = useMemo(() => ({
    loaded, tasks, sessions, events, dailyPlans, settings, chapterProgress, resources, lectures, dailyCheckins, questions, revisions,
    tests, testSyllabus, testAnalysis, weeklyReviews,
    createTask, updateTask, completeTask, deleteTask,
    createSession, updateSession, deleteSession,
    updateSettings, updateChapterProgress, setChapterHistorical, clearAllHistoricalBaseline, setWeeklyReview,
    createResource, updateResource, deleteResource,
    createLecture, updateLecture, deleteLecture,
    setDailyCheckin,
    createQuestion, updateQuestion, deleteQuestion, setImportant, setMistake,
    createRevision, completeRevision,
    createTest, updateTest, deleteTest, setTestResult, addTestSyllabusEntry, removeTestSyllabusEntry, createTestAnalysis, linkTestAnalysisTask,
    importData,
    startChapterRevisionChain, advanceChapterRevisionCycle, regenerateRevisionTask, rescheduleTask,
  }), [loaded, tasks, sessions, events, dailyPlans, settings, chapterProgress, resources, lectures, dailyCheckins, questions, revisions,
      tests, testSyllabus, testAnalysis, weeklyReviews,
      createTask, updateTask, completeTask, deleteTask, createSession, updateSession, deleteSession,
      updateSettings, updateChapterProgress, setChapterHistorical, clearAllHistoricalBaseline, setWeeklyReview, createResource, updateResource, deleteResource,
      createLecture, updateLecture, deleteLecture, setDailyCheckin,
      createQuestion, updateQuestion, deleteQuestion, setImportant, setMistake, createRevision, completeRevision,
      createTest, updateTest, deleteTest, setTestResult, addTestSyllabusEntry, removeTestSyllabusEntry, createTestAnalysis, linkTestAnalysisTask,
      importData, startChapterRevisionChain, advanceChapterRevisionCycle, regenerateRevisionTask, rescheduleTask]);

  return (
    <AppDataContext.Provider value={value}>
      <TimerProvider loaded={loaded} initialActiveTimer={initialActiveTimer} createSession={createSession}>
        {children}
      </TimerProvider>
    </AppDataContext.Provider>
  );
}

/* ------------------------------------------------------------
   FOCUS TIMER — the one timer implementation in this app.
   Countdown is timestamp-based (not interval-accumulated) so it
   stays accurate across tab switches/navigation, and is persisted
   to storage on every state change so it survives reloads.
   ------------------------------------------------------------ */

const TimerContext = createContext(null);
function useTimer() {
  return useContext(TimerContext);
}

function TimerProvider({ children, loaded, initialActiveTimer, createSession }) {
  const [timer, setTimer] = useState(idleTimerState());
  const [tick, setTick] = useState(0);
  const [pendingStop, setPendingStop] = useState(null); // {elapsedSeconds} while confirm dialog open
  const hydrated = useRef(false);
  const completedGuard = useRef(false);

  // Hydrate persisted timer once data provider finishes loading.
  useEffect(() => {
    if (hydrated.current || !loaded) return;
    hydrated.current = true;
    const t = initialActiveTimer;
    if (t && typeof t === "object" && (t.status === "running" || t.status === "paused")
        && Number.isFinite(t.durationSeconds) && t.durationSeconds > 0) {
      // Require startedAt for running timers so remainingSeconds is finite
      if (t.status === "running" && !Number.isFinite(t.startedAt)) return;
      setTimer({
        status: t.status,
        mode: t.mode === "BREAK" ? "BREAK" : "FOCUS",
        durationSeconds: t.durationSeconds,
        startedAt: t.startedAt ?? null,
        pausedRemainingSeconds: Number.isFinite(t.pausedRemainingSeconds) ? t.pausedRemainingSeconds : 0,
        context: t.context && typeof t.context === "object" ? t.context : {},
      });
    }
  }, [loaded, initialActiveTimer]);

  // 1Hz tick to re-render the countdown; also detects natural completion.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingSeconds = useMemo(() => {
    if (timer.status === "running") {
      const elapsed = (Date.now() - timer.startedAt) / 1000;
      return Math.max(0, timer.durationSeconds - elapsed);
    }
    if (timer.status === "paused") return timer.pausedRemainingSeconds;
    return 0;
  }, [timer, tick]);

  const finishSession = useCallback((elapsedSeconds) => {
    const durationMinutes = Math.max(1, Math.round(elapsedSeconds / 60));
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - elapsedSeconds * 1000);
    if (timer.mode === "FOCUS") {
      createSession({
        date: dateToISO(startedAt),
        startTime: startedAt.toTimeString().slice(0, 5),
        endTime: endedAt.toTimeString().slice(0, 5),
        durationMinutes,
        ...timer.context,
        type: timer.context.type || "OTHER",
      });
    }
    setTimer(idleTimerState());
    repo.saveActiveTimer(null);
  }, [timer, createSession]);

  // Natural completion (countdown hits zero) — auto-saves, no confirm needed.
  useEffect(() => {
    if (timer.status === "running" && remainingSeconds <= 0) {
      if (completedGuard.current) return;
      completedGuard.current = true;
      finishSession(timer.durationSeconds);
    } else {
      completedGuard.current = false;
    }
  }, [remainingSeconds, timer, finishSession]);

  const startTimer = useCallback((mode, durationMinutes, context = {}) => {
    const next = {
      status: "running", mode,
      durationSeconds: Math.max(1, durationMinutes) * 60,
      startedAt: Date.now(),
      pausedRemainingSeconds: 0,
      context,
    };
    setTimer(next);
    repo.saveActiveTimer(next);
  }, []);

  const pauseTimer = useCallback(() => {
    setTimer((prev) => {
      if (prev.status !== "running") return prev;
      const elapsed = (Date.now() - prev.startedAt) / 1000;
      const next = { ...prev, status: "paused", pausedRemainingSeconds: Math.max(0, prev.durationSeconds - elapsed) };
      repo.saveActiveTimer(next);
      return next;
    });
  }, []);

  const resumeTimer = useCallback(() => {
    setTimer((prev) => {
      if (prev.status !== "paused") return prev;
      const next = { ...prev, status: "running", startedAt: Date.now() - (prev.durationSeconds - prev.pausedRemainingSeconds) * 1000 };
      repo.saveActiveTimer(next);
      return next;
    });
  }, []);

  // Manual stop before natural completion — ask whether to keep the partial session.
  // Freezes the timer to "paused" immediately so the natural-completion effect
  // (which only fires while status === "running") can't ALSO fire while the
  // confirm dialog is open — that race would otherwise risk two StudySessions
  // for one timer run.
  const requestStop = useCallback(() => {
    const elapsed = timer.status === "paused"
      ? timer.durationSeconds - timer.pausedRemainingSeconds
      : timer.durationSeconds - remainingSeconds;
    if (timer.status === "running") {
      const frozen = { ...timer, status: "paused", pausedRemainingSeconds: Math.max(0, remainingSeconds) };
      setTimer(frozen);
      repo.saveActiveTimer(frozen);
    }
    setPendingStop({ elapsedSeconds: Math.max(0, elapsed) });
  }, [timer, remainingSeconds]);

  const confirmStop = useCallback((save) => {
    if (save && pendingStop && timer.mode === "FOCUS" && pendingStop.elapsedSeconds >= 60) {
      finishSession(pendingStop.elapsedSeconds);
    } else {
      setTimer(idleTimerState());
      repo.saveActiveTimer(null);
    }
    setPendingStop(null);
  }, [pendingStop, timer, finishSession]);

  const value = useMemo(() => ({
    timer, remainingSeconds, pendingStop,
    startTimer, pauseTimer, resumeTimer, requestStop, confirmStop,
  }), [timer, remainingSeconds, pendingStop, startTimer, pauseTimer, resumeTimer, requestStop, confirmStop]);

  return <TimerContext.Provider value={value}>{children}</TimerContext.Provider>;
}

/* ------------------------------------------------------------
   NAV CONFIG
   ------------------------------------------------------------ */

const NAV_SECTIONS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid, ready: true },
  { id: "syllabus", label: "My syllabus", icon: BookOpen, ready: true },
  { id: "calendar", label: "Calendar", icon: CalendarDays, ready: true },
  { id: "sessions", label: "Study sessions", icon: Timer, ready: true },
  { id: "questions", label: "Questions", icon: HelpCircle, ready: true },
  { id: "important", label: "Important", icon: Star, ready: true },
  { id: "mistakes", label: "Mistakes", icon: AlertTriangle, ready: true },
  { id: "backlog", label: "Backlog", icon: Inbox, ready: true },
  { id: "tests", label: "Tests", icon: ClipboardList, ready: true },
  { id: "resources", label: "Resources", icon: Library, ready: true },
  { id: "analytics", label: "Analytics", icon: BarChart3, ready: true },
  { id: "weekly-review", label: "Weekly review", icon: CalendarCheck, ready: true },
  { id: "settings", label: "Settings", icon: Settings, ready: true },
];

/* ------------------------------------------------------------
   SHARED UI PRIMITIVES
   ------------------------------------------------------------ */

function Badge({ children, tone = "neutral" }) {
  const tones = {
    neutral: "bg-slate-800 text-slate-300 border-slate-700",
    critical: "bg-rose-950 text-rose-300 border-rose-800",
    high: "bg-amber-950 text-amber-300 border-amber-800",
    medium: "bg-indigo-950 text-indigo-300 border-indigo-800",
    low: "bg-slate-800 text-slate-400 border-slate-700",
    done: "bg-emerald-950 text-emerald-300 border-emerald-800",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${tones[tone] || tones.neutral}`}>
      {children}
    </span>
  );
}

function Card({ children, className = "" }) {
  return (
    <div className={`bg-[#16161a] border border-slate-800/80 rounded-xl shadow-sm shadow-black/20 ${className}`}>
      {children}
    </div>
  );
}

function Button({ children, onClick, variant = "primary", className = "", type = "button", disabled }) {
  const variants = {
    primary: "bg-indigo-400 text-slate-950 hover:bg-indigo-300 disabled:opacity-50",
    ghost: "bg-transparent text-slate-300 hover:bg-slate-800 border border-slate-700",
    danger: "bg-transparent text-rose-400 hover:bg-rose-950/40 border border-rose-900",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function Modal({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="bg-[#1c1c20] border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-slate-100 font-semibold text-sm tracking-wide">{title}</h3>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function EmptyState({ label, message = "Nothing to show here." }) {
  return (
    <div className="h-full min-h-[50vh] flex flex-col items-center justify-center text-center px-6">
      <div className="w-10 h-10 rounded-full border border-slate-700 flex items-center justify-center mb-4">
        <Circle size={16} className="text-slate-600" />
      </div>
      <p className="text-slate-500 text-sm max-w-xs">{message}</p>
      {label && <p className="text-slate-700 text-xs mt-1 font-mono">{label}</p>}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-slate-400 mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputClass = "w-full bg-[#131316] border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-indigo-500";

/* ------------------------------------------------------------
   TASK CREATE / EDIT MODAL
   ------------------------------------------------------------ */

function TaskModal({ open, onClose, initial, prefill, onSave, onEditExisting }) {
  const { tasks, settings, tests, testSyllabus, sessions, lectures, resources, questions, revisions, chapterProgress } = useAppData();
  const [form, setForm] = useState(() => initial || makeTask(prefill || {}));
  const [warnings, setWarnings] = useState([]); // task-intelligence warnings pending acknowledgement
  useEffect(() => {
    setForm(initial || makeTask(prefill || {}));
    setWarnings([]);
  }, [initial, prefill, open]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function setSubject(subjectId) {
    setForm((f) => ({ ...f, subjectId, chapterId: "", topicId: "", subject: SUBJECTS.find((s) => s.id === subjectId)?.name || "" }));
  }
  function setChapter(chapterId) {
    const c = CHAPTERS.find((x) => x.id === chapterId);
    setForm((f) => ({
      ...f, chapterId, topicId: "",
      subjectId: c?.subjectId || f.subjectId,
      subject: c ? SUBJECTS.find((s) => s.id === c.subjectId)?.name || f.subject : f.subject,
    }));
  }

  const chapter = CHAPTERS.find((c) => c.id === form.chapterId);
  const chapterOptions = CHAPTERS.filter((c) => !form.subjectId || c.subjectId === form.subjectId);

  // TASK INTELLIGENCE — computed only, never mutates the task on its own.
  function computeWarnings() {
    const out = [];
    const duplicate = tasks.find((t) =>
      t.id !== form.id && t.status !== "CANCELLED" &&
      t.date === form.date && t.type === form.type &&
      form.chapterId && t.chapterId === form.chapterId
    );
    if (duplicate) out.push({ kind: "duplicate", message: `A similar ${form.type} task already exists for this date: "${duplicate.title}"`, existing: duplicate });

    const sameDayMinutes = tasks
      .filter((t) => t.id !== form.id && t.date === form.date && t.status !== "CANCELLED")
      .reduce((s, t) => s + safeNumber(t.estimatedMinutes, 0), 0) + safeNumber(form.estimatedMinutes, 0);
    const capacity = settings.dailyCapacityMinutes || 480;
    if (sameDayMinutes > capacity) {
      out.push({ kind: "capacity", message: `This pushes ${form.date} to ${minutesToLabel(sameDayMinutes)} planned, over the ${minutesToLabel(capacity)} daily capacity.` });
    }

    // Bad-task / pre-test-priority detector — only fires when there's an
    // actual upcoming test with an actual syllabus to compare against.
    const nearestTest = [...tests].filter((t) => t.status === "Upcoming").sort((a, b) => a.date.localeCompare(b.date))[0];
    if (nearestTest && form.chapterId) {
      const testChapterIds = testSyllabus.filter((s) => s.testId === nearestTest.id).map((s) => s.chapterId);
      if (testChapterIds.length > 0 && !testChapterIds.includes(form.chapterId)) {
        const suggestions = [...new Set(testChapterIds)]
          .map((id) => ({ chapter: CHAPTERS.find((c) => c.id === id), readiness: getChapterReadiness(id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress).readiness }))
          .filter((s) => s.chapter)
          .sort((a, b) => a.readiness - b.readiness)
          .slice(0, 3);
        out.push({
          kind: "offSyllabus",
          message: `⚠️ PRE-TEST PRIORITY WARNING — this task is outside the syllabus for "${nearestTest.name}" on ${formatDate(nearestTest.date)}.`,
          nearestTest, suggestions,
        });
      }
    }

    // Low-value detector — uses actual task metadata + real prep context,
    // never flags a task generically. Two concrete, documented signals:
    // - a vague, unlinked, very short task (no chapter, <15 min, type OTHER)
    // - time aimed at an already-mastered chapter while a weak chapter
    //   from the syllabus is sitting untouched
    if (form.type === "OTHER" && !form.chapterId && safeNumber(form.estimatedMinutes, 0) < 15) {
      out.push({ kind: "lowValue", message: `This is a short, unlinked task (${safeNumber(form.estimatedMinutes, 0)}m, no chapter) — low prep value. Consider linking it to a chapter or skipping it.` });
    }
    if (form.chapterId) {
      const formChapterStats = getChapterStats(form.chapterId, tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
      const formChapterStatus = getChapterStatus(formChapterStats, getChapterChecklist(formChapterStats, chapterProgress[form.chapterId] || {}));
      if (formChapterStatus === "MASTERED") {
        const weakChapter = CHAPTERS
          .map((c) => ({ c, stats: getChapterStats(c.id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress) }))
          .find(({ c, stats }) => c.id !== form.chapterId && getChapterStatus(stats, getChapterChecklist(stats, chapterProgress[c.id] || {})) === "WEAK");
        if (weakChapter) {
          out.push({ kind: "lowValue", message: `${CHAPTERS.find((c) => c.id === form.chapterId)?.name} is already mastered — ${weakChapter.c.name} is weak and could use this time instead.` });
        }
      }
    }
    return out;
  }

  function doSave() {
    onSave(form);
    onClose();
  }

  function moveAfterTest(test) {
    setForm((f) => ({ ...f, date: dateToISO(addDays(new Date(test.date + "T00:00:00"), 1)) }));
    onSave({ ...form, date: dateToISO(addDays(new Date(test.date + "T00:00:00"), 1)) });
    onClose();
  }

  function replaceWithSuggestion(suggestion) {
    if (!suggestion) return;
    setChapter(suggestion.chapter.id);
    setWarnings([]); // back to the normal form — user must explicitly click Create task again
  }

  function submit() {
    if (!form.title.trim()) return;
    const w = computeWarnings();
    if (w.length > 0) { setWarnings(w); return; }
    doSave();
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? "Edit task" : "New task"}>
      {warnings.length > 0 ? (
        <div>
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 bg-amber-950/40 border border-amber-900 rounded-lg px-3 py-2 mb-2">
              <AlertTriangle size={14} className="text-amber-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs text-amber-200">{w.message}</p>
                {w.kind === "offSyllabus" && w.suggestions.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5">
                    {w.suggestions.map((s) => (
                      <li key={s.chapter.id} className="text-[11px] text-amber-300/80">
                        Higher priority: {s.chapter.name} ({s.readiness}% ready)
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap justify-end gap-2 mt-3">
            <Button variant="ghost" onClick={() => onClose()}>Cancel</Button>
            {warnings.some((w) => w.kind === "duplicate") && (
              <Button variant="ghost" onClick={() => {
                const existing = warnings.find((w) => w.kind === "duplicate").existing;
                onClose();
                onEditExisting && onEditExisting(existing);
              }}>Edit existing</Button>
            )}
            {warnings.some((w) => w.kind === "offSyllabus") && (() => {
              const offSyl = warnings.find((w) => w.kind === "offSyllabus");
              return (
                <>
                  {offSyl.suggestions[0] && (
                    <Button variant="ghost" onClick={() => replaceWithSuggestion(offSyl.suggestions[0])}>Replace</Button>
                  )}
                  <Button variant="ghost" onClick={() => moveAfterTest(offSyl.nearestTest)}>Move after test</Button>
                </>
              );
            })()}
            <Button onClick={doSave}>Keep anyway</Button>
          </div>
        </div>
      ) : (
        <>
          <Field label="Title">
            <input className={inputClass} value={form.title} placeholder="e.g. Thermodynamics — L2 revision"
              onChange={(e) => set("title", e.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Subject">
              <select className={inputClass} value={form.subjectId} onChange={(e) => setSubject(e.target.value)}>
                <option value="">— General —</option>
                {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Chapter">
              <select className={inputClass} value={form.chapterId} onChange={(e) => setChapter(e.target.value)}>
                <option value="">— No chapter —</option>
                {chapterOptions.map((c) => <option key={c.id} value={c.id}>Class {c.classLevel} · {c.name}</option>)}
              </select>
            </Field>
          </div>
          {chapter && (
            <Field label="Topic (optional)">
              <select className={inputClass} value={form.topicId} onChange={(e) => set("topicId", e.target.value)}>
                <option value="">— No topic —</option>
                {chapter.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select className={inputClass} value={form.type} onChange={(e) => set("type", e.target.value)}>
                {TASK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Priority">
              <select className={inputClass} value={form.priority} onChange={(e) => set("priority", e.target.value)}>
                {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <input type="date" className={inputClass} value={form.date} onChange={(e) => set("date", e.target.value)} />
            </Field>
            <Field label="Est. minutes">
              <input type="number" min={5} step={5} className={inputClass} value={form.estimatedMinutes}
                onChange={(e) => set("estimatedMinutes", safeNumber(e.target.value, 30))} />
            </Field>
          </div>
          <Field label="Deadline (optional)">
            <input type="date" className={inputClass} value={form.deadline} onChange={(e) => set("deadline", e.target.value)} />
          </Field>
          {FIRST_STUDY_ELIGIBLE_TYPES.includes(form.type) && form.chapterId && !form.revisionId && (
            <label className="flex items-center gap-2 text-sm text-slate-300 mb-3 cursor-pointer">
              <input type="checkbox" className="w-4 h-4 accent-indigo-400" checked={!!form.countsAsFirstStudy}
                onChange={(e) => set("countsAsFirstStudy", e.target.checked)} />
              Counts as First Study Complete
              <span className="text-xs text-slate-600">(starts this chapter's automatic revision cycle when completed)</span>
            </label>
          )}
          <Field label="Notes">
            <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={submit}>{initial ? "Save changes" : "Create task"}</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------
   STUDY SESSION MODAL (manual log — no timer yet)
   ------------------------------------------------------------ */

function SessionModal({ open, onClose, onSave, prefill }) {
  const { resources, tasks } = useAppData();
  const [form, setForm] = useState(() => makeStudySession(prefill || {}));
  useEffect(() => { if (open) setForm(makeStudySession(prefill || {})); }, [open, prefill]);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function setChapter(chapterId) {
    const c = CHAPTERS.find((x) => x.id === chapterId);
    setForm((f) => ({
      ...f, chapterId, topicId: "", resourceId: "",
      subjectId: c?.subjectId || "", subject: c ? SUBJECTS.find((s) => s.id === c.subjectId)?.name || f.subject : f.subject,
    }));
  }

  function setTime(field, val) {
    setForm((f) => {
      const next = { ...f, [field]: val };
      if (next.startTime && next.endTime) {
        const [sh, sm] = next.startTime.split(":").map(Number);
        const [eh, em] = next.endTime.split(":").map(Number);
        let mins = (eh * 60 + em) - (sh * 60 + sm);
        if (mins > 0) next.durationMinutes = mins;
      }
      return next;
    });
  }

  const chapter = CHAPTERS.find((c) => c.id === form.chapterId);
  const chapterResources = resources.filter((r) => r.chapterId === form.chapterId);
  const chapterTasks = tasks.filter((t) => t.chapterId === form.chapterId && t.status !== "COMPLETED");

  function submit() {
    if (!form.subject.trim() && !form.subjectId) return;
    if (!form.durationMinutes) return;
    onSave(form);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Log study session">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Chapter (optional)">
          <select className={inputClass} value={form.chapterId} onChange={(e) => setChapter(e.target.value)}>
            <option value="">— No chapter —</option>
            {SUBJECTS.map((s) => (
              <optgroup key={s.id} label={s.name}>
                {CHAPTERS.filter((c) => c.subjectId === s.id).map((c) => (
                  <option key={c.id} value={c.id}>Class {c.classLevel} · {c.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>
        <Field label="Subject">
          <input className={inputClass} value={form.subject} placeholder="Biology" disabled={!!form.chapterId}
            onChange={(e) => set("subject", e.target.value)} />
        </Field>
      </div>
      {chapter && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Topic (optional)">
            <select className={inputClass} value={form.topicId} onChange={(e) => set("topicId", e.target.value)}>
              <option value="">— No topic —</option>
              {chapter.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Resource (optional)">
            <select className={inputClass} value={form.resourceId} onChange={(e) => set("resourceId", e.target.value)}>
              <option value="">— No resource —</option>
              {chapterResources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select className={inputClass} value={form.type} onChange={(e) => set("type", e.target.value)}>
            {SESSION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Date">
          <input type="date" className={inputClass} value={form.date} onChange={(e) => set("date", e.target.value)} />
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Start (optional)">
          <input type="time" className={inputClass} value={form.startTime} onChange={(e) => setTime("startTime", e.target.value)} />
        </Field>
        <Field label="End (optional)">
          <input type="time" className={inputClass} value={form.endTime} onChange={(e) => setTime("endTime", e.target.value)} />
        </Field>
        <Field label="Duration (min)">
          <input type="number" min={1} className={inputClass} value={form.durationMinutes}
            onChange={(e) => set("durationMinutes", Math.max(0, safeNumber(e.target.value, 0)))} />
        </Field>
      </div>
      {chapterTasks.length > 0 && (
        <Field label="Link to task (optional)">
          <select className={inputClass} value={form.taskId} onChange={(e) => set("taskId", e.target.value)}>
            <option value="">— No task —</option>
            {chapterTasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </Field>
      )}
      <Field label="Notes">
        <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>Log session</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   START FOCUS + STOP CONFIRM
   ------------------------------------------------------------ */

function StartFocusModal({ open, onClose, prefill }) {
  const timerCtx = useTimer();
  const startTimer = timerCtx?.startTimer;
  const [mode, setMode] = useState("FOCUS");
  const [minutes, setMinutes] = useState(DEFAULT_DURATIONS.FOCUS);

  useEffect(() => { if (open) { setMode("FOCUS"); setMinutes(DEFAULT_DURATIONS.FOCUS); } }, [open]);

  function pickMode(m) { setMode(m); setMinutes(DEFAULT_DURATIONS[m]); }

  function start() {
    if (typeof startTimer === "function") startTimer(mode, minutes, prefill || {});
    onClose();
  }

  const contextLabel = [prefill?.subject, prefill?.type].filter(Boolean).join(" · ");

  return (
    <Modal open={open} onClose={onClose} title="Start focus">
      {contextLabel && <p className="text-xs text-indigo-400 mb-3">{contextLabel}</p>}
      <Field label="Mode">
        <div className="flex gap-2">
          {Object.keys(TIMER_MODES).map((m) => (
            <button key={m} onClick={() => pickMode(m)}
              className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium border ${
                mode === m ? "bg-indigo-400 text-slate-950 border-indigo-400" : "border-slate-700 text-slate-400 hover:bg-slate-800"
              }`}>
              {m.replace("_", " ")}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Duration (minutes)">
        <input type="number" min={1} className={inputClass} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={start} className="flex items-center gap-1"><Play size={14} /> Start</Button>
      </div>
    </Modal>
  );
}

function StopConfirmModal() {
  const ctx = useTimer();
  if (!ctx) return null;
  const { pendingStop, confirmStop } = ctx;
  if (!pendingStop) return null;
  const mins = Math.floor(pendingStop.elapsedSeconds / 60);
  const secs = Math.round(pendingStop.elapsedSeconds % 60);
  return (
    <Modal open onClose={() => confirmStop(false)} title="Save this study session?">
      <p className="text-sm text-slate-400 mb-4">
        You studied for <span className="font-mono text-slate-200">{mins}m {secs}s</span>. Save it as a study session, or discard it?
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="danger" onClick={() => confirmStop(false)}>Discard</Button>
        <Button onClick={() => confirmStop(true)}>Save</Button>
      </div>
    </Modal>
  );
}

function TimerBar() {
  const ctx = useTimer();
  if (!ctx || !ctx.timer) return null;
  const { timer, remainingSeconds, pauseTimer, resumeTimer, requestStop } = ctx;
  if (timer.status === "idle") return null;
  const mins = Math.floor(remainingSeconds / 60);
  const secs = Math.floor(remainingSeconds % 60);
  const label = [timer.context.subject, timer.context.type].filter(Boolean).join(" · ");
  return (
    <div className="flex items-center gap-2 bg-[#16161a] border border-indigo-900/60 rounded-lg px-3 py-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
      <span className="font-mono text-sm text-indigo-300 tabular-nums">{mins}:{String(secs).padStart(2, "0")}</span>
      <span className="text-xs text-slate-500 hidden sm:inline truncate max-w-[8rem]">{timer.mode.replace("_", " ")}{label ? ` · ${label}` : ""}</span>
      {timer.status === "running" ? (
        <button onClick={pauseTimer} className="text-slate-400 hover:text-slate-200"><Pause size={14} /></button>
      ) : (
        <button onClick={resumeTimer} className="text-slate-400 hover:text-slate-200"><Play size={14} /></button>
      )}
      <button onClick={requestStop} className="text-slate-400 hover:text-rose-400"><Square size={14} /></button>
    </div>
  );
}

/* ------------------------------------------------------------
   QUICK ADD
   ------------------------------------------------------------ */

function QuickAddRevisionModal({ open, onClose }) {
  const { createRevision } = useAppData();
  const [chapterId, setChapterId] = useState("");
  const [scheduledDate, setScheduledDate] = useState(() => dateToISO(addDays(new Date(), 1)));
  useEffect(() => { if (open) { setChapterId(""); setScheduledDate(dateToISO(addDays(new Date(), 1))); } }, [open]);

  function submit() {
    if (!chapterId) return;
    createRevision({ targetType: "chapter", targetId: chapterId, revisionType: "Chapter Revision", revisionNumber: 1, scheduledDate, status: "SCHEDULED" });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Schedule revision">
      <Field label="Chapter">
        <select className={inputClass} value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
          <option value="">— Select —</option>
          {SUBJECTS.map((s) => (
            <optgroup key={s.id} label={s.name}>
              {CHAPTERS.filter((c) => c.subjectId === s.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
          ))}
        </select>
      </Field>
      <Field label="Scheduled date">
        <input type="date" className={inputClass} value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={!chapterId}>Schedule</Button>
      </div>
    </Modal>
  );
}

function QuickAdd({ onTask, onSession }) {
  const [open, setOpen] = useState(false);
  const [showTask, setShowTask] = useState(false);
  const [showSession, setShowSession] = useState(false);
  const [showResource, setShowResource] = useState(false);
  const [showFocus, setShowFocus] = useState(false);
  const [showQuestion, setShowQuestion] = useState(false);
  const [questionPrefill, setQuestionPrefill] = useState(null);
  const [showRevision, setShowRevision] = useState(false);

  const options = [
    { label: "Task", ready: true, onClick: () => { setShowTask(true); setOpen(false); } },
    { label: "Study session", ready: true, onClick: () => { setShowSession(true); setOpen(false); } },
    { label: "Resource", ready: true, onClick: () => { setShowResource(true); setOpen(false); } },
    { label: "Start focus", ready: true, onClick: () => { setShowFocus(true); setOpen(false); } },
    { label: "Question", ready: true, onClick: () => { setQuestionPrefill({}); setShowQuestion(true); setOpen(false); } },
    { label: "Important question", ready: true, onClick: () => { setQuestionPrefill({ isImportant: true }); setShowQuestion(true); setOpen(false); } },
    { label: "Mistake", ready: true, onClick: () => { setQuestionPrefill({ isMistake: true }); setShowQuestion(true); setOpen(false); } },
    { label: "Revision", ready: true, onClick: () => { setShowRevision(true); setOpen(false); } },
  ];

  return (
    <div className="relative">
      <Button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1">
        <Plus size={15} /> Quick add
      </Button>
      {open && (
        <div className="absolute right-0 mt-2 w-52 bg-[#1c1c20] border border-slate-800 rounded-xl shadow-xl z-40 overflow-hidden">
          {options.map((opt) => (
            <button
              key={opt.label}
              onClick={opt.ready ? opt.onClick : undefined}
              className={`w-full text-left px-4 py-2.5 text-sm flex items-center justify-between ${
                opt.ready ? "text-slate-200 hover:bg-slate-800/80" : "text-slate-600 cursor-default"
              }`}
            >
              {opt.label}
              {!opt.ready && <span className="text-[10px] text-slate-700">next phase</span>}
            </button>
          ))}
        </div>
      )}
      <TaskModal open={showTask} onClose={() => setShowTask(false)} onSave={onTask} />
      <SessionModal open={showSession} onClose={() => setShowSession(false)} onSave={onSession} />
      <ResourceModal open={showResource} onClose={() => setShowResource(false)} />
      <StartFocusModal open={showFocus} onClose={() => setShowFocus(false)} />
      <QuestionModal open={showQuestion} onClose={() => setShowQuestion(false)} prefill={questionPrefill} />
      <QuickAddRevisionModal open={showRevision} onClose={() => setShowRevision(false)} />
    </div>
  );
}

/* ------------------------------------------------------------
   DASHBOARD
   ------------------------------------------------------------ */

function minutesToLabel(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function daysSinceStart() {
  const start = new Date(PREP_START_DATE + "T00:00:00");
  const now = new Date();
  const diff = Math.floor((now.setHours(0,0,0,0) - start.setHours(0,0,0,0)) / 86400000);
  return diff + 1;
}

function StatCard({ label, value, sub, warn }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-slate-500 font-medium mb-1">{label}</p>
      <p className={`text-2xl font-semibold font-mono ${warn ? "text-amber-400" : "text-slate-100"}`}>{value}</p>
      {sub && <p className="text-xs text-slate-600 mt-1">{sub}</p>}
    </Card>
  );
}

function TaskRow({ task, onComplete, onEdit, onDelete, onReschedule }) {
  const priorityTone = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" }[task.priority];
  const done = task.status === "COMPLETED";
  const cancelled = task.status === "CANCELLED";
  const overdue = !done && !cancelled && task.date < todayISO();
  const [showFocus, setShowFocus] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const chapter = CHAPTERS.find((c) => c.id === task.chapterId);
  return (
    <div className={`flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 last:border-0 flex-wrap ${done ? "opacity-50" : ""}`}>
      <button
        onClick={() => !done && onComplete(task.id)}
        className={`w-5 h-5 rounded-md border flex-shrink-0 flex items-center justify-center ${
          done ? "bg-indigo-400 border-indigo-400" : "border-slate-600 hover:border-indigo-400"
        }`}
      >
        {done && <span className="text-slate-950 text-xs">✓</span>}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm text-slate-200 truncate ${done ? "line-through" : ""}`}>{task.title}</p>
        <p className="text-xs text-slate-500 mt-0.5">
          {[task.subject, chapter?.name].filter(Boolean).join(" · ") || "General"}
          {" · "}{minutesToLabel(task.estimatedMinutes)}
        </p>
      </div>
      {overdue && <Badge tone="critical">OVERDUE</Badge>}
      <Badge tone={priorityTone}>{task.priority}</Badge>
      {!done && (
        <button onClick={() => setShowFocus(true)} title="Start focus" className="text-slate-600 hover:text-indigo-400 px-1">
          <Play size={14} />
        </button>
      )}
      {!done && !cancelled && (
        rescheduling ? (
          <input type="date" autoFocus defaultValue={task.date}
            onBlur={(e) => { onReschedule(task.id, e.target.value); setRescheduling(false); }}
            onChange={(e) => { onReschedule(task.id, e.target.value); setRescheduling(false); }}
            className="bg-[#131316] border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200" />
        ) : (
          <button onClick={() => setRescheduling(true)} className="text-slate-600 hover:text-slate-300 text-xs px-2">Reschedule</button>
        )
      )}
      <button onClick={() => onEdit(task)} className="text-slate-600 hover:text-slate-300 text-xs px-2">Edit</button>
      <button onClick={() => onDelete(task.id)} className="text-slate-600 hover:text-rose-400 text-xs px-2">Delete</button>
      <StartFocusModal open={showFocus} onClose={() => setShowFocus(false)}
        prefill={{ subject: task.subject, chapterId: task.chapterId, topicId: "", type: task.type, taskId: task.id }} />
    </div>
  );
}

/* ------------------------------------------------------------
   DAILY CHECK-IN — asked once per calendar date, never repeated
   unless the person explicitly reopens it to edit.
   ------------------------------------------------------------ */

function DailyCheckinModal({ open, onClose, defaultHours, onSubmit }) {
  const [hours, setHours] = useState(defaultHours);
  useEffect(() => { if (open) setHours(defaultHours); }, [open, defaultHours]);
  return (
    <Modal open={open} onClose={onClose} title="How many focused hours can you realistically study today?">
      <Field label="Hours today">
        <input type="number" min={0} max={20} step={0.5} className={inputClass} value={hours}
          onChange={(e) => setHours(safeNumber(e.target.value, defaultHours))} autoFocus />
      </Field>
      <p className="text-xs text-slate-600 mb-3">This only sets today's available capacity — your default stays in Settings.</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Skip for today</Button>
        <Button onClick={() => { onSubmit(hours); onClose(); }}>Set today's capacity</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   WHAT SHOULD I DO NOW — picks exactly one high-value action
   from real stored Task data only (overdue takes priority over
   today's tasks; priority order breaks ties). Revision/mistake/
   test signals aren't in this yet — those entities don't exist.
   ------------------------------------------------------------ */

const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function pickNextAction(overdueTasks, todayPendingTasks) {
  const pool = overdueTasks.length > 0 ? overdueTasks : todayPendingTasks;
  if (pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || a.date.localeCompare(b.date));
  return { task: sorted[0], reason: overdueTasks.length > 0 ? "overdue" : "today" };
}

function WhatShouldIDoNow({ overdueTasks, todayPendingTasks, onStart }) {
  const pick = pickNextAction(overdueTasks, todayPendingTasks);
  return (
    <Card className="p-4 mb-6 border-indigo-900/60">
      <p className="text-xs text-indigo-400 font-medium mb-2 tracking-wide">WHAT SHOULD I DO NOW?</p>
      {!pick ? (
        <p className="text-sm text-slate-500">Nothing pending — add a task or start a free-form focus session.</p>
      ) : (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm text-slate-200">{pick.task.title}</p>
            <p className="text-xs text-slate-500 mt-0.5">
              {pick.reason === "overdue" ? "Overdue" : "Due today"} · {pick.task.priority} · {minutesToLabel(pick.task.estimatedMinutes)}
            </p>
          </div>
          <Button onClick={() => onStart(pick.task)} className="flex items-center gap-1"><Play size={14} /> Start this</Button>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------
   WHAT SHOULD I REVISE TODAY — real stored Revision + Question
   records only. Priority order: overdue mistakes → overdue
   important questions → overdue chapter revisions → due today →
   weak chapters. "Upcoming test syllabus" is not included — no
   Test entity exists yet, and a fabricated bucket would violate
   "use only real stored records."
   ------------------------------------------------------------ */

function buildRevisionQueue(revisions, questions) {
  const today = todayISO();
  const items = [];
  const scheduled = revisions.filter((r) => r.status === "SCHEDULED");

  function pushQuestionRevisions(revisionType, reason, priority, onlyOverdue) {
    scheduled
      .filter((r) => r.revisionType === revisionType && (onlyOverdue ? r.scheduledDate < today : r.scheduledDate === today))
      .forEach((r) => {
        const q = questions.find((x) => x.id === r.targetId);
        if (!q) return; // orphan-safe: question may have been deleted
        items.push({ kind: "revision", revision: r, question: q, reason, priority, dueDate: r.scheduledDate });
      });
  }

  pushQuestionRevisions("Mistake", "Overdue mistake", 1, true);
  pushQuestionRevisions("Important Question", "Overdue important question", 2, true);
  scheduled.filter((r) => r.targetType === "chapter" && r.scheduledDate < today).forEach((r) => {
    const chapter = CHAPTERS.find((c) => c.id === r.targetId);
    if (!chapter) return;
    items.push({ kind: "chapterRevision", revision: r, chapter, reason: "Overdue chapter revision", priority: 3, dueDate: r.scheduledDate });
  });
  pushQuestionRevisions("Mistake", "Due today", 4, false);
  pushQuestionRevisions("Important Question", "Due today", 4, false);
  scheduled.filter((r) => r.targetType === "chapter" && r.scheduledDate === today).forEach((r) => {
    const chapter = CHAPTERS.find((c) => c.id === r.targetId);
    if (!chapter) return;
    items.push({ kind: "chapterRevision", revision: r, chapter, reason: "Chapter revision due today", priority: 4, dueDate: r.scheduledDate });
  });

  return items.sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
}

// B10/B11 — a read-only, DISPLAY-ONLY priority judgment for an automatic
// chapter revision. Never touches Revision.scheduledDate (that stays the
// Revision Engine's job) or the stored Task.priority field — this is
// purely what "Task Intelligence" surfaces to the user, computed fresh
// each render from real accuracy/mistake/test data, with an actual
// human-readable reason (never fabricated).
function getChapterRevisionPriority(chapterId, tasks, sessions, lectures, resources, questions, revisions, nearestTest, nearestTestChapterIds, chapterProgress = {}) {
  const stats = getChapterStats(chapterId, tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
  const reasons = [];
  let score = 0;
  if (stats.qCount >= 5 && stats.qAccuracy < 60) { reasons.push(`${stats.qAccuracy}% accuracy`); score += 2; }
  if (stats.mistakeCount > 0) { reasons.push(`${stats.mistakeCount} mistake${stats.mistakeCount === 1 ? "" : "s"}`); score += stats.mistakeCount >= 3 ? 2 : 1; }
  if (stats.revisionsDueCount > 0) { reasons.push("revision overdue"); score += 2; }
  let inTest = false;
  if (nearestTest && nearestTestChapterIds && nearestTestChapterIds.includes(chapterId)) {
    const daysRemaining = localDaysBetween(todayISO(), nearestTest.date);
    if (daysRemaining >= 0) { reasons.push(`test in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`); score += daysRemaining <= 3 ? 3 : daysRemaining <= 7 ? 2 : 1; inTest = true; }
  }
  let priority = "MEDIUM";
  if (score >= 5) priority = "CRITICAL";
  else if (score >= 3) priority = "HIGH";
  else if (score <= 0) priority = "LOW";
  const reason = reasons.length === 0 ? null : `${priority === "CRITICAL" ? "Critical" : priority === "HIGH" ? "High" : priority === "LOW" ? "Low" : "Medium"} priority — ${reasons.join(", ")}.`;
  return { priority, reason, inTest };
}

function WhatShouldIRevise({ onOpenQuestion, onOpenChapter }) {
  const { revisions, questions, tasks, sessions, lectures, resources, tests, testSyllabus, chapterProgress, completeRevision, completeTask, regenerateRevisionTask } = useAppData();
  const queue = buildRevisionQueue(revisions, questions);

  const nearestTest = [...tests].filter((t) => t.status === "Upcoming").sort((a, b) => a.date.localeCompare(b.date))[0];
  const nearestTestChapterIds = nearestTest ? testSyllabus.filter((s) => s.testId === nearestTest.id).map((s) => s.chapterId) : [];

  // Weak chapters — real signal now that Mistake/accuracy data exists.
  const weakChapters = CHAPTERS
    .map((c) => ({ c, stats: getChapterStats(c.id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress) }))
    .filter(({ c, stats }) => getChapterStatus(stats, getChapterChecklist(stats, chapterProgress[c.id] || {})) === "WEAK")
    .slice(0, 3);

  if (queue.length === 0 && weakChapters.length === 0) return null;

  return (
    <Card className="p-4 mb-6">
      <p className="text-xs text-slate-400 font-medium mb-3 tracking-wide">WHAT SHOULD I REVISE TODAY?</p>
      <div className="space-y-2">
        {queue.slice(0, 6).map((item, i) => {
          const isChapterRevision = item.kind === "chapterRevision";
          const linkedTask = isChapterRevision ? tasks.find((t) => t.revisionId === item.revision.id && t.status !== "COMPLETED") : null;
          const missingTask = isChapterRevision && !linkedTask;
          const prio = isChapterRevision ? getChapterRevisionPriority(item.chapter.id, tasks, sessions, lectures, resources, questions, revisions, nearestTest, nearestTestChapterIds, chapterProgress) : null;
          return (
            <div key={i} className="flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm text-slate-200 truncate max-w-md">
                  {item.kind === "revision" ? item.question.questionText : item.chapter.name}
                </p>
                <p className="text-xs text-slate-500">{item.reason} · due {formatDate(item.dueDate)}</p>
                {prio?.reason && <p className="text-xs text-amber-400 mt-0.5">{prio.reason}</p>}
                {missingTask && <p className="text-xs text-rose-400 mt-0.5">Revision task missing</p>}
              </div>
              <div className="flex gap-2 flex-shrink-0">
                {missingTask ? (
                  <Button variant="ghost" onClick={() => regenerateRevisionTask(item.revision.id)} className="!py-1 !px-2 text-xs">Regenerate task</Button>
                ) : isChapterRevision ? (
                  <Button variant="ghost" onClick={() => completeTask(linkedTask.id)} className="!py-1 !px-2 text-xs">Mark revised</Button>
                ) : (
                  <Button variant="ghost" onClick={() => completeRevision(item.revision.id)} className="!py-1 !px-2 text-xs">Mark revised</Button>
                )}
                <Button variant="ghost" onClick={() => item.kind === "revision" ? onOpenQuestion(item.question) : onOpenChapter(item.chapter.id)} className="!py-1 !px-2 text-xs">Open</Button>
              </div>
            </div>
          );
        })}
        {weakChapters.map(({ c, stats }) => (
          <div key={c.id} className="flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm text-slate-200 truncate">{c.name}</p>
              <p className="text-xs text-slate-500">Weak chapter · {stats.qAccuracy}% accuracy, {stats.mistakeCount} mistakes</p>
            </div>
            <Button variant="ghost" onClick={() => onOpenChapter(c.id)} className="!py-1 !px-2 text-xs">Open</Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function LastTestCard({ info, onOpenTest }) {
  if (!info) {
    return (
      <Card className="p-4 mb-6">
        <p className="text-xs text-slate-500 font-medium tracking-wide mb-1">LAST TEST</p>
        <p className="text-sm text-slate-600">No completed tests yet.</p>
      </Card>
    );
  }
  const { test, strongest, weakest } = info;
  return (
    <Card className="p-4 mb-6">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-xs text-slate-500 font-medium tracking-wide">LAST TEST</p>
        <Button variant="ghost" onClick={() => onOpenTest(test.id)} className="!py-1 !px-2 text-xs">Open</Button>
      </div>
      <p className="text-sm text-slate-200">{test.name}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
        <StatCard label="Score" value={`${test.score ?? "—"}/${test.maxScore}`} />
        <StatCard label="Accuracy" value={`${test.accuracy ?? 0}%`} />
        <StatCard label="Strongest subject" value={strongest || "—"} />
        <StatCard label="Weakest subject" value={weakest || "—"} />
      </div>
    </Card>
  );
}

function NextTestCard({ info, onOpenTest }) {
  if (!info) return null;
  const { test, daysRemaining, prep, overall, physics, chemistry, biology } = info;
  const fmt = (v) => (v === null ? "—" : `${v}%`);
  return (
    <Card className="p-4 mb-6 border-indigo-900/60">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-xs text-indigo-400 font-medium tracking-wide">NEXT TEST</p>
        <Button variant="ghost" onClick={() => onOpenTest(test.id)} className="!py-1 !px-2 text-xs">Open</Button>
      </div>
      <p className="text-sm text-slate-200">{test.name}</p>
      <p className="text-xs text-slate-500 mb-3">{formatDate(test.date)} · {daysRemaining}d remaining · {prep.mode}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Overall readiness" value={fmt(overall)} />
        <StatCard label="Physics" value={fmt(physics)} />
        <StatCard label="Chemistry" value={fmt(chemistry)} />
        <StatCard label="Biology" value={fmt(biology)} />
      </div>
    </Card>
  );
}

function Dashboard({ onOpenChapter, onOpenQuestion, onOpenTest, onOpenBacklog }) {
  const { tasks, sessions, lectures, resources, questions, revisions, tests, testSyllabus, settings, chapterProgress, dailyCheckins, setDailyCheckin, createTask, updateTask, completeTask, deleteTask, createSession, rescheduleTask } = useAppData();
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showFocus, setShowFocus] = useState(false);
  const [focusPrefill, setFocusPrefill] = useState(null);
  const [showCheckin, setShowCheckin] = useState(false);

  const today = todayISO();

  useEffect(() => {
    if (dailyCheckins[today] === undefined) setShowCheckin(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ask at most once per mount for the current date

  const todayTasks = tasks.filter((t) => t.date === today);
  const overdueTasks = getBacklogTasks(tasks).sort((a, b) => a.date.localeCompare(b.date));
  const plannedMinutes = todayTasks.reduce((s, t) => s + safeNumber(t.estimatedMinutes), 0);
  const completedTasks = todayTasks.filter((t) => t.status === "COMPLETED");
  const remainingTasks = todayTasks.filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED");
  const todaySessions = sessions.filter((s) => s.date === today);
  const actualMinutes = todaySessions.reduce((s, x) => s + safeNumber(x.durationMinutes), 0);
  const todayLectureIds = new Set(
    todaySessions.filter((s) => s.lectureId).map((s) => s.lectureId)
      .filter((id) => {
        const lec = lectures.find((l) => l.id === id);
        return lec && getLectureProgress(lec, sessions).status === "COMPLETED";
      })
  );

  const capacity = dailyCheckins[today] !== undefined ? Math.round(dailyCheckins[today] * 60) : (settings.dailyCapacityMinutes || 480);
  const remainingCapacity = capacity - plannedMinutes;
  const overCapacity = plannedMinutes > capacity;

  // This week / this month — via the same getRangeStats() Analytics uses,
  // so these numbers can never disagree, and local-date string comparison
  // replaces the old `new Date(s.date) >= weekStart` UTC-parsing bug.
  const now = new Date();
  const weekStart = dateToISO(startOfWeek(now));
  const monthStart = dateToISO(startOfMonth(now));
  const weekStats = getRangeStats(weekStart, today, tasks, sessions, questions, tests);
  const monthStats = getRangeStats(monthStart, today, tasks, sessions, questions, tests);
  const weekMinutes = weekStats.focusedMinutes;
  const weekTasksTotal = weekStats.tasksTotal;
  const weekTasksDone = weekStats.tasksCompleted;
  const weekQuestions = weekStats.questionsCount;
  const monthQuestions = monthStats.questionsCount;
  const { current: currentStreak } = computeStreaks(getDailyMinutesMap(sessions));

  const todayLabel = now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // Question / revision stats
  const todayQuestions = questions.filter((q) => q.dateAdded === today);
  const todayCorrect = todayQuestions.filter((q) => q.isCorrect === true).length;
  const todayIncorrect = todayQuestions.filter((q) => q.isCorrect === false).length;
  const todayAccuracy = Math.round(safeDiv(todayCorrect, todayCorrect + todayIncorrect) * 100);
  const importantDue = revisions.filter((r) => r.status === "SCHEDULED" && r.revisionType === "Important Question" && r.scheduledDate <= today).length;
  const mistakesDue = revisions.filter((r) => r.status === "SCHEDULED" && r.revisionType === "Mistake" && r.scheduledDate <= today).length;

  const nearestTest = [...tests].filter((t) => t.status === "Upcoming").sort((a, b) => a.date.localeCompare(b.date))[0];
  let nextTestInfo = null;
  if (nearestTest) {
    const mySyl = testSyllabus.filter((s) => s.testId === nearestTest.id);
    const chapterIds = mySyl.map((s) => s.chapterId);
    const daysRemaining = localDaysBetween(today, nearestTest.date);
    const prep = getPreparationMode(daysRemaining);
    const physicsIds = mySyl.filter((s) => s.section === "Physics").map((s) => s.chapterId);
    const chemistryIds = mySyl.filter((s) => s.section === "Chemistry").map((s) => s.chapterId);
    const biologyIds = mySyl.filter((s) => s.section === "Botany" || s.section === "Zoology").map((s) => s.chapterId);
    nextTestInfo = {
      test: nearestTest, daysRemaining, prep,
      overall: chapterIds.length ? Math.round(chapterIds.reduce((s, id) => s + getChapterReadiness(id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress).readiness, 0) / chapterIds.length) : null,
      physics: getSubjectReadiness(physicsIds, tasks, sessions, lectures, resources, questions, revisions, chapterProgress),
      chemistry: getSubjectReadiness(chemistryIds, tasks, sessions, lectures, resources, questions, revisions, chapterProgress),
      biology: getSubjectReadiness(biologyIds, tasks, sessions, lectures, resources, questions, revisions, chapterProgress),
    };
  }

  // Last completed test — genuinely empty when none exists, never fabricated.
  const lastCompletedTest = [...tests].filter((t) => t.status === "Completed").sort((a, b) => b.date.localeCompare(a.date))[0] || null;
  let lastTestInfo = null;
  if (lastCompletedTest) {
    const scores = [
      { label: "Physics", value: lastCompletedTest.subjectScores?.physics },
      { label: "Chemistry", value: lastCompletedTest.subjectScores?.chemistry },
      { label: "Biology", value: lastCompletedTest.subjectScores?.biology },
    ].filter((s) => s.value !== null && s.value !== undefined);
    const sorted = [...scores].sort((a, b) => b.value - a.value);
    lastTestInfo = {
      test: lastCompletedTest,
      strongest: sorted[0]?.label || null,
      weakest: sorted.length > 1 ? sorted[sorted.length - 1].label : null,
    };
  }

  function startFor(task) {
    setFocusPrefill({ subject: task.subject, chapterId: task.chapterId, topicId: task.topicId, type: task.type, taskId: task.id });
    setShowFocus(true);
  }

  function reschedule(id, date) { rescheduleTask(id, date); }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-baseline justify-between mb-6 flex-wrap gap-2">
        <div>
          <p className="text-xs text-indigo-400 font-mono tracking-wider">DAY {daysSinceStart()}</p>
          <h1 className="text-xl font-semibold text-slate-100">{todayLabel}</h1>
        </div>
        <Button onClick={() => { setFocusPrefill(null); setShowFocus(true); }} className="flex items-center gap-1">
          <Play size={14} /> Start focus
        </Button>
      </div>

      <WhatShouldIDoNow overdueTasks={overdueTasks} todayPendingTasks={remainingTasks} onStart={startFor} />
      <NextTestCard info={nextTestInfo} onOpenTest={onOpenTest} />
      <LastTestCard info={lastTestInfo} onOpenTest={onOpenTest} />
      <WhatShouldIRevise onOpenQuestion={onOpenQuestion} onOpenChapter={onOpenChapter} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Planned focus time" value={minutesToLabel(plannedMinutes)} />
        <StatCard label="Actual focus time" value={minutesToLabel(actualMinutes)} />
        <StatCard label="Tasks completed" value={`${completedTasks.length}/${todayTasks.length}`} />
        <StatCard label="Tasks remaining" value={remainingTasks.length} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Today's questions" value={todayQuestions.length} />
        <StatCard label="Today's accuracy" value={`${todayAccuracy}%`} />
        <StatCard label="Important due" value={importantDue} warn={importantDue > 0} />
        <StatCard label="Mistakes due" value={mistakesDue} warn={mistakesDue > 0} />
      </div>

      <Card className="p-4 mb-6">
        <div className="flex items-center justify-between text-sm mb-2">
          <span className="text-slate-400">Daily capacity</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-slate-300">
              {minutesToLabel(plannedMinutes)} planned · {minutesToLabel(capacity)} available
            </span>
            <button onClick={() => setShowCheckin(true)} className="text-xs text-slate-600 hover:text-indigo-400">Edit</button>
          </div>
        </div>
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full ${overCapacity ? "bg-amber-500" : "bg-indigo-400"}`}
            style={{ width: `${Math.min(100, (plannedMinutes / capacity) * 100)}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-slate-500">
            {remainingCapacity >= 0 ? `${minutesToLabel(remainingCapacity)} remaining` : `${minutesToLabel(-remainingCapacity)} over`}
          </span>
          {overCapacity && (
            <span className="text-xs text-amber-400 flex items-center gap-1">
              <AlertTriangle size={12} /> Day over capacity
            </span>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="Today's sessions" value={todaySessions.length} />
        <StatCard label="Today's lectures done" value={todayLectureIds.size} />
        <StatCard label="Current streak" value={`${currentStreak}d`} />
      </div>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <StatCard label="This week's study time" value={minutesToLabel(weekMinutes)} />
        <StatCard label="This week's tasks" value={`${weekTasksDone}/${weekTasksTotal} done`} />
        <StatCard label="Questions this week" value={weekQuestions} />
      </div>
      <div className="grid grid-cols-1 gap-3 mb-6">
        <StatCard label="Questions this month" value={monthQuestions} />
      </div>

      {overdueTasks.length > 0 && (() => {
        const backlogStats = getBacklogStats(tasks);
        const highestPriority = rankBacklogTasks(overdueTasks, today)[0];
        return (
          <Card className="mb-6 border-rose-900/60">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 flex-wrap gap-2">
              <div>
                <h2 className="text-sm font-semibold text-rose-300">Overdue ({overdueTasks.length})</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Oldest: {formatDate(backlogStats.oldest?.date)} · Highest priority: {highestPriority?.title}
                </p>
              </div>
              <Button variant="ghost" onClick={onOpenBacklog} className="!py-1 !px-2 text-xs">View backlog</Button>
            </div>
            {overdueTasks.map((t) => (
              <TaskRow key={t.id} task={t} onComplete={completeTask} onEdit={setEditing} onDelete={deleteTask} onReschedule={reschedule} />
            ))}
          </Card>
        );
      })()}

      <Card className="mb-6">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-200">Today's tasks</h2>
          <Button variant="ghost" onClick={() => setCreating(true)} className="flex items-center gap-1">
            <Plus size={14} /> Add task
          </Button>
        </div>
        {todayTasks.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-600">
            No tasks planned for today yet. Add one to get started.
          </div>
        ) : (
          todayTasks.map((t) => (
            <TaskRow key={t.id} task={t} onComplete={completeTask} onEdit={setEditing} onDelete={deleteTask} onReschedule={reschedule} />
          ))
        )}
      </Card>

      <TaskModal open={creating} onClose={() => setCreating(false)} onSave={createTask} />
      <TaskModal open={!!editing} initial={editing} onClose={() => setEditing(null)} onSave={(f) => updateTask(f.id, f)} />
      <StartFocusModal open={showFocus} onClose={() => setShowFocus(false)} prefill={focusPrefill} />
      <DailyCheckinModal
        open={showCheckin} onClose={() => setShowCheckin(false)}
        defaultHours={dailyCheckins[today] !== undefined ? dailyCheckins[today] : (settings.dailyCapacityMinutes || 480) / 60}
        onSubmit={(hours) => setDailyCheckin(today, hours)}
      />
    </div>
  );
}

/* ------------------------------------------------------------
   SETTINGS
   ------------------------------------------------------------ */

function ImportPreviewModal({ open, onClose, validation, onConfirm }) {
  if (!open || !validation) return null;
  if (!validation.ok) {
    return (
      <Modal open onClose={onClose} title="Import rejected">
        <div className="bg-rose-950/30 border border-rose-900 rounded-lg p-3 mb-3">
          {validation.errors.map((e, i) => <p key={i} className="text-xs text-rose-300">{e}</p>)}
        </div>
        <p className="text-xs text-slate-500 mb-4">Nothing was changed — your existing data is untouched.</p>
        <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
      </Modal>
    );
  }
  const counts = ARRAY_ENTITY_KEYS.map((k) => `${k}: ${validation.data[k].length}`).join(" · ");
  return (
    <Modal open onClose={onClose} title="Import preview">
      <p className="text-sm text-slate-300 mb-2">File is valid.</p>
      <p className="text-xs text-slate-500 mb-3 font-mono">{counts}</p>
      {validation.normalizedCount > 0 && (
        <p className="text-xs text-amber-400 mb-3">{validation.normalizedCount} reference(s) pointed at an unknown chapter/subject and were safely cleared rather than imported broken.</p>
      )}
      <p className="text-xs text-slate-500 mb-4">
        <strong className="text-slate-300">Merge</strong> keeps everything you have and adds/updates by ID.{" "}
        <strong className="text-slate-300">Replace</strong> replaces your entire dataset with this file.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="ghost" onClick={() => onConfirm("merge")}>Merge</Button>
        <Button variant="danger" onClick={() => onConfirm("replace")}>Replace everything</Button>
      </div>
    </Modal>
  );
}

function DataBackupSection() {
  const data = useAppData();
  const [validation, setValidation] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [importDone, setImportDone] = useState(null);
  const fileInputRef = useRef(null);

  function exportJSON() {
    const payload = buildExportPayload(data);
    downloadTextFile(`neet-prep-os-backup-${todayISO()}.json`, JSON.stringify(payload, null, 2), "application/json");
  }

  function exportCSV(kind) {
    let csv, filename;
    if (kind === "questions") {
      csv = toCSV(data.questions, [
        { label: "Question", get: (q) => q.questionText }, { label: "Subject", get: (q) => SUBJECTS.find((s) => s.id === q.subjectId)?.name || "" },
        { label: "Chapter", get: (q) => CHAPTERS.find((c) => c.id === q.chapterId)?.name || "" }, { label: "Source", get: (q) => q.source },
        { label: "Difficulty", get: (q) => q.difficulty }, { label: "Correct answer", get: (q) => q.correctAnswer },
        { label: "My answer", get: (q) => q.myAnswer }, { label: "Result", get: (q) => (q.isCorrect === true ? "Correct" : q.isCorrect === false ? "Incorrect" : "") },
        { label: "Important", get: (q) => (q.isImportant ? "Yes" : "") }, { label: "Mistake", get: (q) => (q.isMistake ? "Yes" : "") },
        { label: "Has image", get: (q) => (q.image ? "Yes" : "") },
        { label: "Notes", get: (q) => q.notes }, { label: "Date added", get: (q) => q.dateAdded },
      ]);
      filename = `questions-${todayISO()}.csv`;
    } else if (kind === "sessions") {
      csv = toCSV(data.sessions, [
        { label: "Date", get: (s) => s.date }, { label: "Start", get: (s) => s.startTime }, { label: "End", get: (s) => s.endTime },
        { label: "Duration (min)", get: (s) => s.durationMinutes }, { label: "Subject", get: (s) => s.subject },
        { label: "Chapter", get: (s) => CHAPTERS.find((c) => c.id === s.chapterId)?.name || "" }, { label: "Type", get: (s) => s.type },
        { label: "Notes", get: (s) => s.notes },
      ]);
      filename = `study-sessions-${todayISO()}.csv`;
    } else {
      csv = toCSV(data.tests, [
        { label: "Test number", get: (t) => t.testNumber }, { label: "Name", get: (t) => t.name }, { label: "Date", get: (t) => t.date },
        { label: "Series", get: (t) => t.series }, { label: "Status", get: (t) => t.status }, { label: "Score", get: (t) => t.score ?? "" },
        { label: "Max score", get: (t) => t.maxScore }, { label: "Accuracy", get: (t) => t.accuracy ?? "" },
        { label: "Physics", get: (t) => t.subjectScores?.physics ?? "" }, { label: "Chemistry", get: (t) => t.subjectScores?.chemistry ?? "" },
        { label: "Biology", get: (t) => t.subjectScores?.biology ?? "" }, { label: "Notes", get: (t) => t.notes },
      ]);
      filename = `tests-${todayISO()}.csv`;
    }
    downloadTextFile(filename, csv, "text/csv");
  }

  function onFileChosen(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setValidation(validateImportPayload(String(reader.result || "")));
      setShowPreview(true);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function confirmImport(mode) {
    if (!validation?.ok) return;
    data.importData(validation.data, mode);
    setShowPreview(false);
    setImportDone(mode);
  }

  return (
    <Card className="p-4 mt-4">
      <p className="text-sm font-semibold text-slate-200 mb-1">Data backup</p>
      <p className="text-xs text-slate-600 mb-3">Everything lives only on this device. Export regularly, especially before clearing browser data.</p>

      <div className="flex flex-wrap gap-2 mb-3">
        <Button variant="ghost" onClick={exportJSON}>Export full backup (JSON)</Button>
        <Button variant="ghost" onClick={() => exportCSV("questions")}>Export Questions (CSV)</Button>
        <Button variant="ghost" onClick={() => exportCSV("sessions")}>Export Sessions (CSV)</Button>
        <Button variant="ghost" onClick={() => exportCSV("tests")}>Export Tests (CSV)</Button>
      </div>

      <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={onFileChosen} />
      <Button variant="ghost" onClick={() => fileInputRef.current?.click()}>Import backup (JSON)</Button>
      {importDone && <p className="text-xs text-emerald-400 mt-2">Import complete ({importDone}).</p>}

      <ImportPreviewModal open={showPreview} onClose={() => setShowPreview(false)} validation={validation} onConfirm={confirmImport} />
    </Card>
  );
}

function AutoRevisionSettingsCard({ settings, updateSettings }) {
  const enabled = settings.autoRevisionEnabled !== false;

  function setIntervals(subjectId, index, value) {
    const current = getSubjectIntervals(subjectId, settings);
    const next = [...current];
    next[index] = Math.min(365, Math.max(1, Math.round(safeNumber(value, current[index]))));
    updateSettings({ revisionIntervals: { ...settings.revisionIntervals, [subjectId]: next } });
  }
  function setDuration(subjectId, value) {
    updateSettings({ revisionDurations: { ...settings.revisionDurations, [subjectId]: Math.max(5, Math.min(240, Math.round(safeNumber(value, 45)))) } });
  }

  return (
    <Card className="p-4 mb-4">
      <div className="flex items-center justify-between mb-1">
        <p className="text-sm font-semibold text-slate-200">Automatic revision scheduling</p>
        <FilterPills value={enabled ? "on" : "off"} onChange={(v) => updateSettings({ autoRevisionEnabled: v === "on" })}
          options={[{ id: "on", label: "ON" }, { id: "off", label: "OFF" }]} />
      </div>
      <p className="text-xs text-slate-600 mb-3">
        When ON, marking a study task "Counts as First Study Complete" starts that chapter's R1–R5 revision
        cycle automatically. Turning this OFF only stops new chains from starting — it never touches chains
        already running, and manual revisions always keep working either way.
      </p>
      {SUBJECTS.map((s) => {
        const intervals = getSubjectIntervals(s.id, settings);
        const duration = getSubjectRevisionDuration(s.id, settings);
        return (
          <div key={s.id} className="mb-3 last:mb-0">
            <p className="text-xs text-slate-400 mb-1">{s.name}</p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {intervals.map((n, i) => (
                <div key={i} className="flex items-center gap-1">
                  <span className="text-[10px] text-slate-600">R{i + 1}</span>
                  <input type="number" min={1} max={365} value={n}
                    onChange={(e) => setIntervals(s.id, i, e.target.value)}
                    className="w-12 bg-[#131316] border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 text-center" />
                </div>
              ))}
              <span className="text-[10px] text-slate-600 ml-2">days · duration</span>
              <input type="number" min={5} max={240} value={duration}
                onChange={(e) => setDuration(s.id, e.target.value)}
                className="w-14 bg-[#131316] border border-slate-700 rounded px-1 py-0.5 text-xs text-slate-200 text-center" />
              <span className="text-[10px] text-slate-600">min</span>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function SettingsPage() {
  const { settings, updateSettings, clearAllHistoricalBaseline, chapterProgress, setChapterHistorical } = useAppData();
  const hours = Math.floor((settings.dailyCapacityMinutes || 480) / 60);
  const theme = settings.theme || "dark";
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [baselineMode, setBaselineMode] = useState(settings.prepBaseline?.mode || "percent");
  const [pct, setPct] = useState(settings.prepBaseline?.completedPercent ?? "");
  const [remNum, setRemNum] = useState(settings.prepBaseline?.remainingNumerator ?? "");
  const [remDen, setRemDen] = useState(settings.prepBaseline?.remainingDenominator ?? "");

  useEffect(() => {
    const b = settings.prepBaseline;
    if (b) {
      setBaselineMode(b.mode || "percent");
      setPct(b.completedPercent ?? "");
      setRemNum(b.remainingNumerator ?? "");
      setRemDen(b.remainingDenominator ?? "");
    }
  }, [settings.prepBaseline]);

  function saveBaseline() {
    if (baselineMode === "percent") {
      const p = Math.min(100, Math.max(0, safeNumber(pct, NaN)));
      if (!Number.isFinite(p)) return;
      updateSettings({ prepBaseline: { mode: "percent", completedPercent: Math.round(p), remainingNumerator: null, remainingDenominator: null, updatedAt: new Date().toISOString() } });
    } else {
      const n = safeNumber(remNum, NaN);
      const d = safeNumber(remDen, NaN);
      if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || n < 0 || n > d) return;
      const completed = Math.round((1 - n / d) * 100);
      updateSettings({ prepBaseline: { mode: "fraction", completedPercent: completed, remainingNumerator: n, remainingDenominator: d, updatedAt: new Date().toISOString() } });
    }
  }

  function clearBaseline() {
    if (!window.confirm("Clear overall baseline and all chapter historical states? Live sessions/questions/tasks are NOT deleted.")) return;
    clearAllHistoricalBaseline();
    setPct(""); setRemNum(""); setRemDen("");
  }

  return (
    <div className="p-6 max-w-lg mx-auto">
      <h1 className="text-xl font-semibold text-slate-100 mb-6">Settings</h1>
      <Card className="p-4 mb-4">
        <Field label="Theme">
          <FilterPills value={theme} onChange={(v) => updateSettings({ theme: v })}
            options={[{ id: "dark", label: "Dark" }, { id: "night", label: "Night" }]} />
        </Field>
        <p className="text-xs text-slate-600">
          Dark is the standard charcoal/indigo theme. Night is a deeper, lower-glare near-black
          variant of the same theme — same layout, same everything, just an easier-on-the-eyes palette.
        </p>
      </Card>
      <Card className="p-4 mb-4">
        <Field label="Daily focused study capacity (hours)">
          <input
            type="number" min={1} max={16} className={inputClass}
            value={hours}
            onChange={(e) => updateSettings({ dailyCapacityMinutes: Number(e.target.value) * 60 })}
          />
        </Field>
        <p className="text-xs text-slate-600">Used to calculate remaining daily capacity on the dashboard. Default is 8 hours.</p>
      </Card>

      <Card className="p-4 mb-4">
        <p className="text-sm font-semibold text-slate-200 mb-2">Current preparation baseline</p>
        <p className="text-xs text-slate-500 mb-3">
          Overall syllabus completion before you started using this app. This is a global baseline —
          it does not set every chapter to the same %. Does not create fake activity.
        </p>
        <FilterPills value={baselineMode} onChange={setBaselineMode}
          options={[{ id: "percent", label: "% completed" }, { id: "fraction", label: "Remaining fraction" }]} />
        {baselineMode === "percent" ? (
          <Field label="Overall syllabus completed (%)">
            <input type="number" min={0} max={100} className={inputClass} value={pct} onChange={(e) => setPct(e.target.value)} placeholder="e.g. 80" />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Remaining numerator">
              <input type="number" min={0} className={inputClass} value={remNum} onChange={(e) => setRemNum(e.target.value)} placeholder="1" />
            </Field>
            <Field label="Remaining denominator">
              <input type="number" min={1} className={inputClass} value={remDen} onChange={(e) => setRemDen(e.target.value)} placeholder="5" />
            </Field>
          </div>
        )}
        {settings.prepBaseline?.completedPercent != null && (
          <p className="text-xs text-indigo-400 mb-2">Saved: {settings.prepBaseline.completedPercent}% complete
            {settings.prepBaseline.mode === "fraction" ? ` (${settings.prepBaseline.remainingNumerator}/${settings.prepBaseline.remainingDenominator} remaining)` : ""}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={saveBaseline}>Save baseline</Button>
          <Button variant="ghost" onClick={() => setMigrationOpen(true)}>Migration workflow</Button>
          <Button variant="danger" onClick={clearBaseline}>Clear historical baseline</Button>
        </div>
      </Card>

      <AutoRevisionSettingsCard settings={settings} updateSettings={updateSettings} />
      <DataBackupSection />
      <PrepMigrationModal open={migrationOpen} onClose={() => setMigrationOpen(false)} />
    </div>
  );
}

function PrepMigrationModal({ open, onClose }) {
  const { settings, updateSettings, chapterProgress, setChapterHistorical } = useAppData();
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState("percent");
  const [pct, setPct] = useState("");
  const [remNum, setRemNum] = useState("1");
  const [remDen, setRemDen] = useState("5");
  const [bulk, setBulk] = useState(() => {
    const m = {};
    CHAPTERS.forEach((c) => {
      const h = chapterProgress[c.id]?.historical || {};
      m[c.id] = {
        completion: h.completionHint ?? "",
        lectures: h.lecturesCompleted != null && h.lecturesTotal != null ? `${h.lecturesCompleted}/${h.lecturesTotal}` : "",
        questions: h.questionsCompleted ?? "",
        pyq: h.pyqCompleted ?? "",
        revisions: h.revisionCount ?? "",
      };
    });
    return m;
  });

  useEffect(() => {
    if (open) {
      setStep(1);
      const b = settings.prepBaseline;
      if (b) {
        setMode(b.mode || "percent");
        setPct(b.completedPercent ?? "");
        setRemNum(b.remainingNumerator ?? "1");
        setRemDen(b.remainingDenominator ?? "5");
      }
    }
  }, [open, settings.prepBaseline]);

  function setBulkField(id, k, v) {
    setBulk((prev) => ({ ...prev, [id]: { ...prev[id], [k]: v } }));
  }

  function applySave() {
    // Step 1 baseline
    let completedPercent = null;
    if (mode === "percent") {
      const p = Math.min(100, Math.max(0, safeNumber(pct, NaN)));
      if (Number.isFinite(p)) {
        completedPercent = Math.round(p);
        updateSettings({ prepBaseline: { mode: "percent", completedPercent, remainingNumerator: null, remainingDenominator: null, updatedAt: new Date().toISOString() } });
      }
    } else {
      const n = safeNumber(remNum, NaN);
      const d = safeNumber(remDen, NaN);
      if (Number.isFinite(n) && Number.isFinite(d) && d > 0 && n >= 0 && n <= d) {
        completedPercent = Math.round((1 - n / d) * 100);
        updateSettings({ prepBaseline: { mode: "fraction", completedPercent, remainingNumerator: n, remainingDenominator: d, updatedAt: new Date().toISOString() } });
      }
    }
    // Bulk chapter historical (only rows with any value)
    CHAPTERS.forEach((c) => {
      const row = bulk[c.id] || {};
      const has = Object.values(row).some((v) => v !== "" && v != null);
      if (!has) return;
      let lecC = null, lecT = null;
      if (row.lectures && String(row.lectures).includes("/")) {
        const [a, b] = String(row.lectures).split("/");
        lecC = Math.max(0, Math.round(safeNumber(a, 0)));
        lecT = Math.max(0, Math.round(safeNumber(b, 0)));
      }
      const q = row.questions === "" ? null : Math.max(0, Math.round(safeNumber(row.questions, 0)));
      const pyq = row.pyq === "" ? null : Math.max(0, Math.round(safeNumber(row.pyq, 0)));
      const rev = row.revisions === "" ? null : Math.max(0, Math.round(safeNumber(row.revisions, 0)));
      const existing = chapterProgress[c.id]?.historical || {};
      setChapterHistorical(c.id, {
        ...existing,
        lecturesCompleted: lecC ?? existing.lecturesCompleted ?? null,
        lecturesTotal: lecT ?? existing.lecturesTotal ?? null,
        questionsCompleted: q ?? existing.questionsCompleted ?? null,
        pyqCompleted: pyq ?? existing.pyqCompleted ?? null,
        revisionCount: rev ?? existing.revisionCount ?? null,
        completionHint: row.completion === "" ? (existing.completionHint ?? null) : row.completion,
      });
    });
    setStep(4);
  }

  return (
    <Modal open={open} onClose={onClose} title="Current preparation setup">
      <div className="flex gap-2 mb-4 text-[11px]">
        {[1, 2, 3, 4].map((s) => (
          <span key={s} className={`px-2 py-0.5 rounded ${step === s ? "bg-indigo-400 text-slate-950" : "bg-slate-800 text-slate-500"}`}>Step {s}</span>
        ))}
      </div>
      {step === 1 && (
        <>
          <p className="text-xs text-slate-500 mb-3">Overall baseline only — not applied per chapter.</p>
          <FilterPills value={mode} onChange={setMode} options={[{ id: "percent", label: "% completed" }, { id: "fraction", label: "Remaining fraction" }]} />
          {mode === "percent" ? (
            <Field label="Completed %"><input type="number" min={0} max={100} className={inputClass} value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Remaining num"><input type="number" min={0} className={inputClass} value={remNum} onChange={(e) => setRemNum(e.target.value)} /></Field>
              <Field label="Denominator"><input type="number" min={1} className={inputClass} value={remDen} onChange={(e) => setRemDen(e.target.value)} /></Field>
            </div>
          )}
          <div className="flex justify-end gap-2 mt-3">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={() => setStep(2)}>Next</Button>
          </div>
        </>
      )}
      {step === 2 && (
        <>
          <p className="text-xs text-slate-500 mb-2">Optional bulk chapter init. Leave blank to skip. Format lectures as completed/total.</p>
          <div className="max-h-64 overflow-y-auto border border-slate-800 rounded-lg">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-[#1c1c20]">
                <tr className="text-slate-500 text-left">
                  <th className="px-2 py-1">Chapter</th>
                  <th className="px-1 py-1">Lectures</th>
                  <th className="px-1 py-1">Questions</th>
                  <th className="px-1 py-1">PYQ</th>
                  <th className="px-1 py-1">Revs</th>
                </tr>
              </thead>
              <tbody>
                {CHAPTERS.map((c) => (
                  <tr key={c.id} className="border-t border-slate-800/50">
                    <td className="px-2 py-1 text-slate-400 truncate max-w-[120px]">{c.name}</td>
                    <td className="px-1 py-1"><input className={inputClass + " !py-0.5 !text-[11px]"} value={bulk[c.id]?.lectures || ""} onChange={(e) => setBulkField(c.id, "lectures", e.target.value)} placeholder="14/14" /></td>
                    <td className="px-1 py-1"><input className={inputClass + " !py-0.5 !text-[11px]"} value={bulk[c.id]?.questions || ""} onChange={(e) => setBulkField(c.id, "questions", e.target.value)} /></td>
                    <td className="px-1 py-1"><input className={inputClass + " !py-0.5 !text-[11px]"} value={bulk[c.id]?.pyq || ""} onChange={(e) => setBulkField(c.id, "pyq", e.target.value)} /></td>
                    <td className="px-1 py-1"><input className={inputClass + " !py-0.5 !text-[11px]"} value={bulk[c.id]?.revisions || ""} onChange={(e) => setBulkField(c.id, "revisions", e.target.value)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
            <Button onClick={() => setStep(3)}>Next</Button>
          </div>
        </>
      )}
      {step === 3 && (
        <>
          <p className="text-xs text-slate-500 mb-2">Review — nothing is written until Save.</p>
          <p className="text-sm text-slate-300 mb-1">Baseline: {mode === "percent" ? `${pct}%` : `${remNum}/${remDen} remaining`}</p>
          <p className="text-xs text-slate-500 mb-3">
            Chapters with bulk data: {Object.values(bulk).filter((r) => Object.values(r).some((v) => v !== "" && v != null)).length}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
            <Button onClick={applySave}>Save</Button>
          </div>
        </>
      )}
      {step === 4 && (
        <>
          <p className="text-sm text-slate-300 mb-4">Baseline and chapter historical state saved. Live records were not created.</p>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------
   MY SYLLABUS
   ------------------------------------------------------------ */

const SORT_OPTIONS = [
  { id: "alpha", label: "Alphabetical" },
  { id: "progress", label: "Progress" },
  { id: "weakest", label: "Weakest first" },
  { id: "recent", label: "Recently studied" },
  { id: "mostQuestions", label: "Most questions" },
  { id: "leastQuestions", label: "Least questions" },
];

function SyllabusPage({ onOpenChapter }) {
  const { tasks, sessions, lectures, resources, questions, revisions, chapterProgress, settings } = useAppData();
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [classFilter, setClassFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("alpha");

  const enriched = useMemo(() => CHAPTERS.map((c) => {
    const stats = getChapterStats(c.id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
    const checklist = getChapterChecklist(stats, chapterProgress[c.id] || {});
    const status = getChapterStatus(stats, checklist);
    return { ...c, stats, checklist, status };
  }), [tasks, sessions, lectures, resources, questions, revisions, chapterProgress]);

  const baselinePct = settings.prepBaseline?.completedPercent;
  const checklistAvg = Math.round(
    enriched.reduce((s, c) => s + c.checklist.overallProgress, 0) / (enriched.length || 1)
  );
  // Overall display prefers explicit prep baseline when set; checklist avg remains the chapter-level average.
  const overallProgress = baselinePct != null ? Math.round(safeNumber(baselinePct, checklistAvg)) : checklistAvg;

  const subjectStats = SUBJECTS.map((s) => {
    const chs = enriched.filter((c) => c.subjectId === s.id && (classFilter === "all" || c.classLevel === Number(classFilter)));
    const started = chs.filter((c) => c.status !== "NOT_STARTED").length;
    const progress = Math.round(chs.reduce((sum, c) => sum + c.checklist.overallProgress, 0) / (chs.length || 1));
    return { ...s, total: chs.length, started, progress };
  });

  let filtered = enriched.filter((c) =>
    (subjectFilter === "all" || c.subjectId === subjectFilter) &&
    (classFilter === "all" || c.classLevel === Number(classFilter)) &&
    (statusFilter === "all" || c.status === statusFilter)
  );

  filtered = [...filtered].sort((a, b) => {
    if (sortBy === "alpha") return a.name.localeCompare(b.name);
    if (sortBy === "progress") return b.checklist.overallProgress - a.checklist.overallProgress;
    if (sortBy === "weakest") return a.checklist.overallProgress - b.checklist.overallProgress;
    if (sortBy === "recent") return (b.stats.lastStudied || "").localeCompare(a.stats.lastStudied || "");
    if (sortBy === "mostQuestions") return b.stats.questionsLogged - a.stats.questionsLogged;
    if (sortBy === "leastQuestions") return a.stats.questionsLogged - b.stats.questionsLogged;
    return 0;
  });

  const groups = SUBJECTS
    .filter((s) => subjectFilter === "all" || s.id === subjectFilter)
    .map((s) => ({
      subject: s,
      classes: [11, 12]
        .filter((cl) => classFilter === "all" || cl === Number(classFilter))
        .map((cl) => ({ classLevel: cl, chapters: filtered.filter((c) => c.subjectId === s.id && c.classLevel === cl) }))
        .filter((g) => g.chapters.length > 0),
    }))
    .filter((g) => g.classes.length > 0);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <p className="text-xs text-slate-500 font-medium tracking-wide">MY SYLLABUS</p>
        <div className="flex items-baseline gap-3 mt-1">
          <h1 className="text-2xl font-semibold text-slate-100 font-mono">{overallProgress}%</h1>
          <span className="text-sm text-slate-500">
            {baselinePct != null ? "baseline · " : "checklist avg · "}{enriched.length} chapters
            {baselinePct != null && <span className="text-slate-600"> · checklist avg {checklistAvg}%</span>}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {subjectStats.map((s) => (
          <Card key={s.id} className="p-4">
            <p className="text-sm font-semibold text-slate-200 mb-2">{s.name.toUpperCase()}</p>
            <p className="text-xl font-mono text-indigo-400">{s.progress}%</p>
            <p className="text-xs text-slate-500 mt-1">{s.started}/{s.total} chapters started</p>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <FilterPills value={subjectFilter} onChange={setSubjectFilter}
          options={[{ id: "all", label: "All" }, ...SUBJECTS.map((s) => ({ id: s.id, label: s.name }))]} />
        <FilterPills value={classFilter} onChange={setClassFilter}
          options={[{ id: "all", label: "All classes" }, { id: "11", label: "Class 11" }, { id: "12", label: "Class 12" }]} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All statuses</option>
          {Object.keys(STATUS_LABEL).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400 ml-auto">
          {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
        </select>
      </div>

      {groups.map((g) => (
        <div key={g.subject.id} className="mb-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-2">{g.subject.name.toUpperCase()}</h2>
          {g.classes.map((cg) => (
            <div key={cg.classLevel} className="mb-3">
              <p className="text-xs text-slate-600 mb-1 px-1">Class {cg.classLevel}</p>
              <Card>
                {cg.chapters.map((c) => (
                  <ChapterRow key={c.id} chapter={c} onClick={() => onOpenChapter(c.id)} />
                ))}
              </Card>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FilterPills({ value, onChange, options }) {
  return (
    <div className="flex gap-1 bg-[#16161a] border border-slate-800 rounded-full p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`px-3 py-1 rounded-full ${value === o.id ? "bg-indigo-400 text-slate-950 font-medium" : "text-slate-400 hover:text-slate-200"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ChapterRow({ chapter, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30 text-left"
    >
      <ChevronRight size={14} className="text-slate-600 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200 truncate">{chapter.name}</p>
        <p className="text-xs text-slate-600 mt-0.5">
          L {chapter.stats.lecturesTotalCount > 0 ? `${chapter.stats.lecturesCompletedCount}/${chapter.stats.lecturesTotalCount}` : chapter.stats.lecturesLogged}
          {" "}· Q {chapter.stats.questionsLogged} · Rev {chapter.stats.revisionsLogged}/{REVISION_TARGET}
          {chapter.stats.lastStudied ? ` · last ${formatDate(chapter.stats.lastStudied)}` : " · never studied"}
        </p>
      </div>
      <span className="font-mono text-sm text-slate-400 w-10 text-right">{chapter.checklist.overallProgress}%</span>
      <Badge tone={STATUS_TONE[chapter.status]}>{STATUS_LABEL[chapter.status]}</Badge>
    </button>
  );
}

/* ------------------------------------------------------------
   CHAPTER CONTROL CENTER
   ------------------------------------------------------------ */

function ChapterPage({ chapterId, onBack }) {
  const { tasks, sessions, resources, lectures, questions, revisions, chapterProgress, updateChapterProgress, setChapterHistorical, createTask, createSession, createQuestion, createRevision } = useAppData();
  const [showTask, setShowTask] = useState(false);
  const [showSession, setShowSession] = useState(false);
  const [showResource, setShowResource] = useState(false);
  const [showQuestion, setShowQuestion] = useState(false);
  const [showScheduleRevision, setShowScheduleRevision] = useState(false);
  const [showCurrentState, setShowCurrentState] = useState(false);
  const [topicsOpen, setTopicsOpen] = useState(true);
  const [openResource, setOpenResource] = useState(null);

  const chapter = CHAPTERS.find((c) => c.id === chapterId);
  const stats = getChapterStats(chapterId, tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
  const manual = chapterProgress[chapterId] || {};
  const checklist = getChapterChecklist(stats, manual);
  const status = getChapterStatus(stats, checklist);
  const subject = SUBJECTS.find((s) => s.id === chapter?.subjectId);

  if (!chapter) return <EmptyState label="chapter not found" message="Chapter not found." />;

  const prefill = { subject: subject?.name || "", subjectId: chapter.subjectId, chapterId: chapter.id };
  const chapterResources = resources.filter((r) => r.chapterId === chapterId);
  const chapterSessions = sessions.filter((s) => s.chapterId === chapterId)
    .sort((a, b) => (b.date + (b.startTime || "")).localeCompare(a.date + (a.startTime || "")));

  const RESOURCE_GROUPS = [
    { label: "Lectures", types: ["LECTURE", "VIDEO"] },
    { label: "Notes", types: ["NOTES", "PERSONAL_NOTES", "MODULE"] },
    { label: "Questions", types: ["DPP", "QUESTION_BANK"] },
    { label: "PYQs", types: ["PYQ", "JEE_MAIN"] },
    { label: "NCERT", types: ["NCERT"] },
    { label: "Other", types: ["TEST", "PDF", "WEBSITE", "OTHER"] },
  ];

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300 mb-4">← Back to syllabus</button>

      <div className="flex items-start justify-between mb-1 gap-3">
        <h1 className="text-xl font-semibold text-slate-100">{chapter.name}</h1>
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      </div>
      <p className="text-sm text-slate-500 mb-6">{subject?.name} · Class {chapter.classLevel}</p>

      <Card className="p-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-500">Overall progress</span>
          <span className="font-mono text-lg text-indigo-400">{checklist.overallProgress}%</span>
        </div>
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full bg-indigo-400" style={{ width: `${checklist.overallProgress}%` }} />
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <StatCard label="Lectures"
          value={stats.lecturesTotalCount > 0 ? `${stats.lecturesCompletedCount}/${stats.lecturesTotalCount}` : stats.lecturesLogged}
          sub={stats.lecturesTotalCount === 0 ? "logged" : undefined} />
        <StatCard label="Theory" value={manual.theory ? "100%" : "0%"} />
        <StatCard label="Questions" value={stats.qCount} />
        <StatCard label="Accuracy" value={`${stats.qAccuracy}%`} sub={`${stats.qCorrect}/${stats.qCorrect + stats.qIncorrect} scored`} />
        <StatCard label="PYQs" value={stats.pyqLogged} />
        <StatCard label="Revision" value={`${stats.revisionsLogged}/${REVISION_TARGET}`} sub={stats.revisionsDueCount > 0 ? `${stats.revisionsDueCount} due` : undefined} warn={stats.revisionsDueCount > 0} />
        <StatCard label="Test readiness" value={`${checklist.overallProgress}%`} warn={!checklist.testReady} />
        <StatCard label="Important questions" value={stats.importantCount} />
        <StatCard label="Mistakes" value={stats.mistakeCount} />
        <StatCard label="Last studied" value={formatDate(stats.lastStudied) || "Never"} />
        <StatCard label="Last revision" value={formatDate(stats.lastRevision) || "Never"} />
      </div>

      <Card className="p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-3">Checklist</h2>
        {checklist.items.map((item) => (
          <label key={item.key} className="flex items-center gap-3 py-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={item.checked}
              disabled={item.derived}
              onChange={(e) => !item.derived && updateChapterProgress(chapterId, { [item.key]: e.target.checked })}
              className="w-4 h-4 accent-indigo-400"
            />
            <span className={`text-sm ${item.checked ? "text-slate-300" : "text-slate-500"}`}>{item.label}</span>
            {item.derived && <span className="text-[10px] text-slate-700 ml-auto">auto-tracked</span>}
          </label>
        ))}
        <div className="flex items-center gap-3 py-1.5 pt-2 mt-1 border-t border-slate-800/60">
          <input type="checkbox" checked={checklist.testReady} disabled className="w-4 h-4 accent-indigo-400" />
          <span className={`text-sm ${checklist.testReady ? "text-slate-300" : "text-slate-500"}`}>Test-ready</span>
          <span className="text-[10px] text-slate-700 ml-auto">auto-tracked</span>
        </div>
      </Card>

      <Card className="p-4 mb-6">
        <button onClick={() => setTopicsOpen((v) => !v)} className="w-full flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">Topics ({chapter.topics.length})</h2>
          <ChevronRight size={14} className={`text-slate-500 transition-transform ${topicsOpen ? "rotate-90" : ""}`} />
        </button>
        {topicsOpen && (
          <ul className="mt-3 space-y-1.5">
            {chapter.topics.map((t) => (
              <li key={t.id} className="text-sm text-slate-400 pl-4 border-l border-slate-800">{t.name}</li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-3">Quick actions</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setShowTask(true)}>+ Add task</Button>
          <Button variant="ghost" onClick={() => setShowSession(true)}>+ Log study session</Button>
          <Button variant="ghost" onClick={() => setShowResource(true)}>+ Add resource</Button>
          <Button variant="ghost" onClick={() => setShowQuestion(true)}>+ Add question</Button>
          <Button variant="ghost" onClick={() => setShowScheduleRevision(true)}>+ Schedule revision</Button>
          <Button variant="ghost" onClick={() => setShowCurrentState(true)}>Set current state</Button>
        </div>
        {stats.historical && (
          <p className="text-[11px] text-slate-600 mt-2">Historical baseline is set for this chapter (does not create live sessions/questions).</p>
        )}
      </Card>

      <Card className="p-4 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-200">Resources ({chapterResources.length})</h2>
          <Button variant="ghost" onClick={() => setShowResource(true)} className="flex items-center gap-1 !py-1 !px-2 text-xs">
            <Plus size={12} /> Add
          </Button>
        </div>
        {chapterResources.length === 0 ? (
          <p className="text-sm text-slate-600">No resources added yet.</p>
        ) : (
          <div className="space-y-4">
            {RESOURCE_GROUPS.map((g) => {
              const items = chapterResources.filter((r) => g.types.includes(r.type));
              if (items.length === 0) return null;
              return (
                <div key={g.label}>
                  <p className="text-xs text-slate-600 mb-1.5">{g.label.toUpperCase()}</p>
                  <div className="space-y-1">
                    {items.map((r) => (
                      <button key={r.id} onClick={() => setOpenResource(r)}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[#131316] hover:bg-slate-800/50 text-left">
                        <span className="text-sm text-slate-300 truncate">{r.name}</span>
                        <Badge tone={r.status === "COMPLETED" ? "done" : r.status === "NEEDS_REVISION" ? "critical" : "neutral"}>
                          {r.status.replace("_", " ")}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-3">Study history</h2>
        <div className="grid grid-cols-3 gap-3 mb-3">
          <StatCard label="Focused time" value={minutesToLabel(stats.studyMinutes)} />
          <StatCard label="Sessions" value={chapterSessions.length} />
          <StatCard label="Last studied" value={formatDate(stats.lastStudied) || "Never"} />
        </div>
        {chapterSessions.length > 0 && (
          <div className="space-y-1">
            {chapterSessions.slice(0, 5).map((s) => (
              <div key={s.id} className="flex items-center justify-between text-xs text-slate-500 px-1 py-1.5 border-b border-slate-800/50 last:border-0">
                <span>{formatDate(s.date)}</span>
                <span>{s.type}</span>
                <span className="truncate max-w-[8rem]">{chapter.topics.find((t) => t.id === s.topicId)?.name || "—"}</span>
                <span className="font-mono text-slate-400">{minutesToLabel(s.durationMinutes)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4 mb-6">
        <h2 className="text-sm font-semibold text-slate-200 mb-2">Tests</h2>
        <p className="text-sm text-slate-600">No tests reference this chapter yet.</p>
      </Card>

      <TaskModal open={showTask} onClose={() => setShowTask(false)} prefill={prefill} onSave={createTask} />
      <SessionModal open={showSession} onClose={() => setShowSession(false)} prefill={prefill} onSave={createSession} />
      <ResourceModal open={showResource} onClose={() => setShowResource(false)} prefill={prefill} />
      {openResource && <ResourceDetailModal resource={openResource} onClose={() => setOpenResource(null)} onOpenChapter={onBack} />}
      <QuestionModal open={showQuestion} onClose={() => setShowQuestion(false)} prefill={{ subjectId: chapter.subjectId, chapterId: chapter.id }} />
      <ScheduleRevisionModal open={showScheduleRevision} onClose={() => setShowScheduleRevision(false)}
        targetType="chapter" targetId={chapterId} onSave={createRevision} />
      <ChapterCurrentStateModal open={showCurrentState} onClose={() => setShowCurrentState(false)}
        chapterId={chapterId} existing={stats.historical} onSave={(h) => setChapterHistorical(chapterId, h)} />
    </div>
  );
}

function emptyHistorical() {
  return {
    lecturesCompleted: "", lecturesTotal: "", theoryComplete: false, ncertComplete: false,
    questionsCompleted: "", historicalCorrect: "", historicalIncorrect: "",
    pyqCompleted: "", pyqTotal: "", jeeCompleted: "", jeeTotal: "",
    revisionCount: "", lastStudied: "", lastRevised: "",
  };
}

function ChapterCurrentStateModal({ open, onClose, chapterId, existing, onSave }) {
  const [form, setForm] = useState(() => ({ ...emptyHistorical(), ...(existing || {}) }));
  useEffect(() => {
    if (open) {
      const base = emptyHistorical();
      if (existing) {
        Object.keys(base).forEach((k) => {
          if (existing[k] != null && existing[k] !== "") base[k] = existing[k];
        });
        base.theoryComplete = !!existing.theoryComplete;
        base.ncertComplete = !!existing.ncertComplete;
      }
      setForm(base);
    }
  }, [open, existing]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function submit() {
    const num = (v) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = safeNumber(v, NaN);
      return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
    };
    const dateOk = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const historical = {
      lecturesCompleted: num(form.lecturesCompleted),
      lecturesTotal: num(form.lecturesTotal),
      theoryComplete: !!form.theoryComplete,
      ncertComplete: !!form.ncertComplete,
      questionsCompleted: num(form.questionsCompleted),
      historicalCorrect: num(form.historicalCorrect),
      historicalIncorrect: num(form.historicalIncorrect),
      pyqCompleted: num(form.pyqCompleted),
      pyqTotal: num(form.pyqTotal),
      jeeCompleted: num(form.jeeCompleted),
      jeeTotal: num(form.jeeTotal),
      revisionCount: num(form.revisionCount),
      lastStudied: dateOk(form.lastStudied),
      lastRevised: dateOk(form.lastRevised),
    };
    // Drop all-empty historical
    const hasAny = Object.entries(historical).some(([k, v]) => {
      if (k === "theoryComplete" || k === "ncertComplete") return v === true;
      return v != null && v !== "";
    });
    onSave(hasAny ? historical : null);
    onClose();
  }

  function clear() {
    onSave(null);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Set current state">
      <p className="text-xs text-slate-500 mb-3">
        Initialize historical preparation for this chapter. Does not create sessions, questions, tasks, or revisions.
        Leave fields blank if unknown.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Lectures completed"><input type="number" min={0} className={inputClass} value={form.lecturesCompleted} onChange={(e) => set("lecturesCompleted", e.target.value)} /></Field>
        <Field label="Lectures total"><input type="number" min={0} className={inputClass} value={form.lecturesTotal} onChange={(e) => set("lecturesTotal", e.target.value)} /></Field>
      </div>
      <div className="flex gap-4 mb-3">
        <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" className="accent-indigo-400" checked={!!form.theoryComplete} onChange={(e) => set("theoryComplete", e.target.checked)} /> Theory complete</label>
        <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" className="accent-indigo-400" checked={!!form.ncertComplete} onChange={(e) => set("ncertComplete", e.target.checked)} /> NCERT complete</label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Questions completed"><input type="number" min={0} className={inputClass} value={form.questionsCompleted} onChange={(e) => set("questionsCompleted", e.target.value)} /></Field>
        <Field label="Historical correct"><input type="number" min={0} className={inputClass} value={form.historicalCorrect} onChange={(e) => set("historicalCorrect", e.target.value)} /></Field>
        <Field label="Historical incorrect"><input type="number" min={0} className={inputClass} value={form.historicalIncorrect} onChange={(e) => set("historicalIncorrect", e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="PYQ completed"><input type="number" min={0} className={inputClass} value={form.pyqCompleted} onChange={(e) => set("pyqCompleted", e.target.value)} /></Field>
        <Field label="PYQ total"><input type="number" min={0} className={inputClass} value={form.pyqTotal} onChange={(e) => set("pyqTotal", e.target.value)} /></Field>
        <Field label="JEE Main completed"><input type="number" min={0} className={inputClass} value={form.jeeCompleted} onChange={(e) => set("jeeCompleted", e.target.value)} /></Field>
        <Field label="JEE Main total"><input type="number" min={0} className={inputClass} value={form.jeeTotal} onChange={(e) => set("jeeTotal", e.target.value)} /></Field>
      </div>
      <Field label="Historical revision count"><input type="number" min={0} className={inputClass} value={form.revisionCount} onChange={(e) => set("revisionCount", e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Last studied"><input type="date" className={inputClass} value={form.lastStudied || ""} onChange={(e) => set("lastStudied", e.target.value)} /></Field>
        <Field label="Last revised"><input type="date" className={inputClass} value={form.lastRevised || ""} onChange={(e) => set("lastRevised", e.target.value)} /></Field>
      </div>
      <div className="flex justify-between gap-2 mt-4">
        <Button variant="danger" onClick={clear}>Clear historical</Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   RESOURCE LIBRARY
   ------------------------------------------------------------ */

function ResourceModal({ open, onClose, initial, prefill }) {
  const { createResource, updateResource } = useAppData();
  const [form, setForm] = useState(() => initial || makeResource(prefill || {}));
  const [tagsText, setTagsText] = useState(() => (initial?.tags || []).join(", "));
  useEffect(() => {
    if (open) {
      setForm(initial || makeResource(prefill || {}));
      setTagsText((initial?.tags || []).join(", "));
    }
  }, [open, initial, prefill]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function setSubject(subjectId) { setForm((f) => ({ ...f, subjectId, chapterId: "", topicId: "" })); }
  function setChapter(chapterId) { setForm((f) => ({ ...f, chapterId, topicId: "" })); }

  const chapterOptions = CHAPTERS.filter((c) => !form.subjectId || c.subjectId === form.subjectId);
  const chapter = CHAPTERS.find((c) => c.id === form.chapterId);

  function submit() {
    if (!form.name.trim()) return;
    const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    if (initial) updateResource(initial.id, { ...form, tags });
    else createResource({ ...form, tags });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? "Edit resource" : "Add resource"}>
      <Field label="Name">
        <input className={inputClass} value={form.name} placeholder="e.g. PW Lakshya — Electrostatics lectures"
          onChange={(e) => set("name", e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Source">
          <select className={inputClass} value={form.source} onChange={(e) => set("source", e.target.value)}>
            {RESOURCE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className={inputClass} value={form.type} onChange={(e) => set("type", e.target.value)}>
            {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Subject">
          <select className={inputClass} value={form.subjectId} onChange={(e) => setSubject(e.target.value)}>
            <option value="">— None —</option>
            {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Chapter">
          <select className={inputClass} value={form.chapterId} onChange={(e) => setChapter(e.target.value)} disabled={!form.subjectId}>
            <option value="">— None —</option>
            {chapterOptions.map((c) => <option key={c.id} value={c.id}>Class {c.classLevel} · {c.name}</option>)}
          </select>
        </Field>
      </div>
      {chapter && (
        <Field label="Topic (optional)">
          <select className={inputClass} value={form.topicId} onChange={(e) => set("topicId", e.target.value)}>
            <option value="">— None —</option>
            {chapter.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="URL (optional)">
        <input className={inputClass} value={form.url} placeholder="https://…" onChange={(e) => set("url", e.target.value)} />
      </Field>
      <Field label="Status">
        <select className={inputClass} value={form.status} onChange={(e) => set("status", e.target.value)}>
          {RESOURCE_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
      </Field>
      <Field label="Description">
        <textarea className={inputClass} rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
      </Field>
      <Field label="Tags (comma separated)">
        <input className={inputClass} value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>{initial ? "Save changes" : "Add resource"}</Button>
      </div>
    </Modal>
  );
}

function LectureAddForm({ resourceId, chapterId, topicId, nextNumber, onAdd }) {
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState(30);

  function submit() {
    if (!title.trim()) return;
    onAdd({ resourceId, chapterId, topicId, lectureNumber: nextNumber, title, durationMinutes: Number(duration) });
    setTitle(""); setDuration(30);
  }

  return (
    <div className="flex items-center gap-2 mt-2">
      <span className="text-xs text-slate-600 font-mono w-6">#{nextNumber}</span>
      <input className={inputClass + " flex-1"} placeholder="Lecture title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input type="number" min={1} className={inputClass + " w-20"} value={duration} onChange={(e) => setDuration(e.target.value)} />
      <Button variant="ghost" onClick={submit} className="!px-2">Add</Button>
    </div>
  );
}

function LectureRow({ lecture, sessions, onToggleComplete, onStart }) {
  const progress = getLectureProgress(lecture, sessions);
  const done = progress.status === "COMPLETED";
  return (
    <div className="flex items-center gap-3 py-2 border-b border-slate-800/50 last:border-0">
      <button
        onClick={() => onToggleComplete(lecture, !lecture.manualComplete)}
        className={`w-5 h-5 rounded-md border flex-shrink-0 flex items-center justify-center ${
          done ? "bg-indigo-400 border-indigo-400" : "border-slate-600 hover:border-indigo-400"
        }`}
      >
        {done && <span className="text-slate-950 text-xs">✓</span>}
      </button>
      <span className="text-xs text-slate-600 font-mono w-6">#{lecture.lectureNumber}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-sm text-slate-300 truncate ${done ? "line-through opacity-60" : ""}`}>{lecture.title}</p>
        <p className="text-xs text-slate-600">{progress.watchedMinutes}/{lecture.durationMinutes} min</p>
      </div>
      <Badge tone={done ? "done" : progress.status === "IN_PROGRESS" ? "medium" : "neutral"}>{progress.status.replace("_", " ")}</Badge>
      {!done && (
        <button onClick={() => onStart(lecture)} title="Start lecture" className="text-slate-600 hover:text-indigo-400">
          <Play size={14} />
        </button>
      )}
    </div>
  );
}

function ResourceDetailModal({ resource, onClose, onOpenChapter }) {
  const { updateResource, deleteResource, lectures, sessions, createLecture, updateLecture } = useAppData();
  const [editing, setEditing] = useState(false);
  const [showFocus, setShowFocus] = useState(null); // lecture being started

  const chapter = CHAPTERS.find((c) => c.id === resource.chapterId);
  const subject = SUBJECTS.find((s) => s.id === resource.subjectId);
  const topic = chapter?.topics.find((t) => t.id === resource.topicId);
  const isLectureSeries = resource.type === "LECTURE";
  const own = lectures.filter((l) => l.resourceId === resource.id).sort((a, b) => a.lectureNumber - b.lectureNumber);
  const resourceProgress = getResourceProgress(resource, lectures, sessions);
  const totalDuration = own.reduce((s, l) => s + l.durationMinutes, 0);
  const watchedDuration = own.reduce((s, l) => s + getLectureProgress(l, sessions).watchedMinutes, 0);

  function toggleComplete(lecture, manualComplete) {
    updateLecture(lecture.id, { manualComplete, completedAt: manualComplete ? new Date().toISOString() : "" });
  }

  return (
    <>
      <Modal open onClose={onClose} title={resource.name}>
        <div className="flex flex-wrap gap-1.5 mb-3">
          <Badge>{resource.source}</Badge>
          <Badge>{resource.type.replace("_", " ")}</Badge>
          <Badge tone={resource.status === "COMPLETED" ? "done" : resource.status === "NEEDS_REVISION" ? "critical" : "neutral"}>
            {resource.status.replace("_", " ")}
          </Badge>
        </div>
        {(subject || chapter) && (
          <p className="text-xs text-slate-500 mb-3">
            {[subject?.name, chapter?.name, topic?.name].filter(Boolean).join(" · ")}
          </p>
        )}
        {resource.url && (
          <a href={resource.url} target="_blank" rel="noreferrer" className="text-xs text-indigo-400 hover:underline break-all block mb-3">
            {resource.url}
          </a>
        )}
        {resource.description && <p className="text-sm text-slate-400 mb-3">{resource.description}</p>}
        {resource.notes && <p className="text-xs text-slate-600 mb-3 whitespace-pre-wrap">{resource.notes}</p>}
        <p className="text-[11px] text-slate-700 mb-4">Added {formatDate(resource.createdAt)}</p>

        {isLectureSeries ? (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-slate-500">
                {resourceProgress.completed}/{resourceProgress.total} lectures completed
              </p>
              <p className="text-xs text-slate-600 font-mono">
                {minutesToLabel(watchedDuration)} / {minutesToLabel(totalDuration)}
              </p>
            </div>
            <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden mb-3">
              <div className="h-full bg-indigo-400" style={{ width: `${resourceProgress.total ? (resourceProgress.completed / resourceProgress.total) * 100 : 0}%` }} />
            </div>
            {own.map((l) => (
              <LectureRow key={l.id} lecture={l} sessions={sessions} onToggleComplete={toggleComplete} onStart={setShowFocus} />
            ))}
            <LectureAddForm
              resourceId={resource.id} chapterId={resource.chapterId} topicId={resource.topicId}
              nextNumber={own.length + 1} onAdd={createLecture}
            />
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 mt-4">
          <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
          <Button variant="ghost" onClick={() => updateResource(resource.id, { status: "COMPLETED" })}>Mark complete</Button>
          <Button variant="ghost" onClick={() => updateResource(resource.id, { status: "NEEDS_REVISION" })}>Needs revision</Button>
          {chapter && <Button variant="ghost" onClick={() => { onOpenChapter && onOpenChapter(chapter.id); onClose(); }}>Open chapter</Button>}
          <Button variant="danger" onClick={() => { deleteResource(resource.id); onClose(); }}>Delete</Button>
        </div>
      </Modal>
      <ResourceModal open={editing} onClose={() => setEditing(false)} initial={resource} />
      <StartFocusModal
        open={!!showFocus} onClose={() => setShowFocus(null)}
        prefill={showFocus ? {
          subject: subject?.name, subjectId: resource.subjectId, chapterId: resource.chapterId,
          topicId: resource.topicId, resourceId: resource.id, lectureId: showFocus.id, type: "LECTURE",
        } : {}}
      />
    </>
  );
}

const RESOURCE_SORTS = [
  { id: "recent", label: "Recently added" },
  { id: "updated", label: "Recently updated" },
  { id: "alpha", label: "Alphabetical" },
];

function ResourcesPage({ onOpenChapter }) {
  const { resources } = useAppData();
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [chapterFilter, setChapterFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("recent");
  const [showAdd, setShowAdd] = useState(false);
  const [openResource, setOpenResource] = useState(null);

  const chapterOptions = subjectFilter === "all" ? CHAPTERS : CHAPTERS.filter((c) => c.subjectId === subjectFilter);

  let filtered = resources.filter((r) =>
    (!search || r.name.toLowerCase().includes(search.toLowerCase())) &&
    (subjectFilter === "all" || r.subjectId === subjectFilter) &&
    (chapterFilter === "all" || r.chapterId === chapterFilter) &&
    (sourceFilter === "all" || r.source === sourceFilter) &&
    (typeFilter === "all" || r.type === typeFilter) &&
    (statusFilter === "all" || r.status === statusFilter)
  );
  filtered = [...filtered].sort((a, b) => {
    if (sortBy === "alpha") return a.name.localeCompare(b.name);
    if (sortBy === "updated") return b.updatedAt.localeCompare(a.updatedAt);
    return b.createdAt.localeCompare(a.createdAt);
  });

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <p className="text-xs text-slate-500 font-medium tracking-wide">RESOURCE LIBRARY</p>
          <h1 className="text-xl font-semibold text-slate-100 mt-1">{resources.length} resources</h1>
        </div>
        <Button onClick={() => setShowAdd(true)} className="flex items-center gap-1"><Plus size={14} /> Add resource</Button>
      </div>

      <div className="flex items-center gap-2 bg-[#16161a] border border-slate-800 rounded-lg px-3 py-2 mb-4 max-w-sm">
        <Search size={14} className="text-slate-600" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search resources"
          className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none w-full" />
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <select value={subjectFilter} onChange={(e) => { setSubjectFilter(e.target.value); setChapterFilter("all"); }}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All subjects</option>
          {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={chapterFilter} onChange={(e) => setChapterFilter(e.target.value)}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All chapters</option>
          {chapterOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All sources</option>
          {RESOURCE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All types</option>
          {RESOURCE_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All statuses</option>
          {RESOURCE_STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
          className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400 ml-auto">
          {RESOURCE_SORTS.map((o) => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-600">
          {resources.length === 0 ? "No resources added yet." : "No resources match these filters."}
        </Card>
      ) : (
        <Card>
          {filtered.map((r) => {
            const chapter = CHAPTERS.find((c) => c.id === r.chapterId);
            return (
              <button key={r.id} onClick={() => setOpenResource(r)}
                className="w-full flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30 text-left">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200 truncate">{r.name}</p>
                  <p className="text-xs text-slate-600 mt-0.5">{[r.source, chapter?.name].filter(Boolean).join(" · ") || "Unlinked"}</p>
                </div>
                <Badge>{r.type.replace("_", " ")}</Badge>
                <Badge tone={r.status === "COMPLETED" ? "done" : r.status === "NEEDS_REVISION" ? "critical" : "neutral"}>
                  {r.status.replace("_", " ")}
                </Badge>
              </button>
            );
          })}
        </Card>
      )}

      <ResourceModal open={showAdd} onClose={() => setShowAdd(false)} />
      {openResource && <ResourceDetailModal resource={openResource} onClose={() => setOpenResource(null)} onOpenChapter={onOpenChapter} />}
    </div>
  );
}

/* ------------------------------------------------------------
   STUDY SESSIONS
   ------------------------------------------------------------ */

function SessionRow({ session, onEdit, onDelete }) {
  const chapter = CHAPTERS.find((c) => c.id === session.chapterId);
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200 truncate">{chapter?.name || session.subject || "Untitled session"}</p>
        <p className="text-xs text-slate-500 mt-0.5">
          {formatDate(session.date)} · {session.type}{session.startTime ? ` · ${session.startTime}–${session.endTime}` : ""}
        </p>
      </div>
      <span className="font-mono text-sm text-slate-300">{minutesToLabel(session.durationMinutes)}</span>
      <button onClick={() => onEdit(session)} className="text-slate-600 hover:text-slate-300 text-xs px-2">Edit</button>
      <button onClick={() => onDelete(session.id)} className="text-slate-600 hover:text-rose-400 text-xs px-2">Delete</button>
    </div>
  );
}

const SESSION_TABS = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "all", label: "All time" },
];

function StudySessionsPage() {
  const { sessions, createSession, updateSession, deleteSession } = useAppData();
  const [tab, setTab] = useState("today");
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);

  const now = new Date();
  const today = todayISO();
  const weekStart = dateToISO(startOfWeek(now));
  const monthStart = dateToISO(startOfMonth(now));

  let scoped = sessions;
  if (tab === "today") scoped = sessions.filter((s) => s.date === today);
  else if (tab === "week") scoped = sessions.filter((s) => s.date >= weekStart);
  else if (tab === "month") scoped = sessions.filter((s) => s.date >= monthStart);

  const filtered = scoped.filter((s) => {
    if (!search) return true;
    const chapter = CHAPTERS.find((c) => c.id === s.chapterId);
    return (chapter?.name || s.subject || "").toLowerCase().includes(search.toLowerCase());
  }).sort((a, b) => (b.date + (b.startTime || "")).localeCompare(a.date + (a.startTime || "")));

  const totalMinutes = scoped.reduce((s, x) => s + (x.durationMinutes || 0), 0);
  const avg = scoped.length ? Math.round(totalMinutes / scoped.length) : 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Study sessions</h1>
        <Button onClick={() => setShowAdd(true)} className="flex items-center gap-1"><Plus size={14} /> Add study session</Button>
      </div>

      <FilterPills value={tab} onChange={setTab} options={SESSION_TABS} />

      <div className="grid grid-cols-3 gap-3 my-4">
        <StatCard label="Focused time" value={minutesToLabel(totalMinutes)} />
        <StatCard label="Sessions" value={scoped.length} />
        <StatCard label="Avg. session" value={minutesToLabel(avg)} />
      </div>

      <div className="flex items-center gap-2 bg-[#16161a] border border-slate-800 rounded-lg px-3 py-2 mb-4 max-w-sm">
        <Search size={14} className="text-slate-600" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by chapter/subject"
          className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none w-full" />
      </div>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-600">No study sessions in this range yet.</Card>
      ) : (
        <Card>
          {filtered.map((s) => (
            <SessionRow key={s.id} session={s} onEdit={setEditing} onDelete={deleteSession} />
          ))}
        </Card>
      )}

      <SessionModal open={showAdd} onClose={() => setShowAdd(false)} onSave={createSession} />
      <SessionModal open={!!editing} onClose={() => setEditing(null)} onSave={(f) => editing && updateSession(editing.id, f)} prefill={editing || undefined} />
    </div>
  );
}

/* ------------------------------------------------------------
   CALENDAR — Day/Week/Month/Year/Agenda, all computed live from
   Tasks + Study Sessions + Tests + Revisions. Nothing here stores
   a duplicate "calendar event" record — every event carries a
   `ref` back to its real source record.
   ------------------------------------------------------------ */

function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function startOfWeek(date) { const d = new Date(date); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); d.setHours(0, 0, 0, 0); return d; }
function startOfMonth(date) { return new Date(date.getFullYear(), date.getMonth(), 1); }

function getEventsForDate(dateStr, tasks, sessions, tests = [], revisions = [], questions = []) {
  const out = [];
  tasks.filter((t) => t.date === dateStr).forEach((t) =>
    out.push({ kind: "Task", label: t.title, sub: t.subject, done: t.status === "COMPLETED", ref: t }));
  sessions.filter((s) => s.date === dateStr).forEach((s) => {
    const chapter = CHAPTERS.find((c) => c.id === s.chapterId);
    out.push({ kind: "Session", label: chapter?.name || s.subject || "Study session", sub: `${minutesToLabel(s.durationMinutes)} · ${s.type}`, done: true, ref: s });
  });
  tests.filter((t) => t.date === dateStr).forEach((t) =>
    out.push({ kind: "Test", label: t.name, sub: t.series || t.status, done: t.status === "Completed", ref: t }));
  revisions.filter((r) => r.status === "SCHEDULED" && r.scheduledDate === dateStr).forEach((r) => {
    let label = r.revisionType;
    if (r.targetType === "question") label = questions.find((q) => q.id === r.targetId)?.questionText?.slice(0, 40) || r.revisionType;
    else if (r.targetType === "chapter") label = CHAPTERS.find((c) => c.id === r.targetId)?.name || r.revisionType;
    out.push({ kind: "Revision", label, sub: r.revisionType, done: false, ref: r });
  });
  return out;
}

const CALENDAR_VIEWS = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
  { id: "agenda", label: "Agenda" },
];

const CALENDAR_KIND_TONE = { Task: "medium", Session: "done", Test: "medium", Revision: "critical" };
const CALENDAR_KIND_DOT = { Task: "bg-sky-400", Session: "bg-violet-400", Test: "bg-indigo-400", Revision: "bg-amber-400" };

function DayEventList({ events }) {
  if (events.length === 0) return <p className="text-sm text-slate-600 px-1">Nothing scheduled or logged.</p>;
  return (
    <Card>
      {events.map((e, idx) => (
        <div key={idx} className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-800/60 last:border-0">
          <Badge tone={CALENDAR_KIND_TONE[e.kind] || "neutral"}>{e.kind}</Badge>
          <div className="flex-1 min-w-0">
            <p className={`text-sm text-slate-200 truncate ${e.done && e.kind === "Task" ? "line-through opacity-60" : ""}`}>{e.label}</p>
            {e.sub && <p className="text-xs text-slate-600">{e.sub}</p>}
          </div>
        </div>
      ))}
    </Card>
  );
}

function CalendarPage() {
  const { tasks, sessions, tests, revisions, questions } = useAppData();
  const [view, setView] = useState("month");
  const [anchor, setAnchor] = useState(new Date());

  function jumpToDay(date) { setAnchor(date); setView("day"); }

  function nav(dir) {
    setAnchor((a) => {
      if (view === "day") return addDays(a, dir);
      if (view === "week") return addDays(a, dir * 7);
      if (view === "month") return new Date(a.getFullYear(), a.getMonth() + dir, 1);
      if (view === "year") return new Date(a.getFullYear() + dir, a.getMonth(), 1);
      return a;
    });
  }

  const headerLabel =
    view === "day" ? anchor.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) :
    view === "week" ? `Week of ${formatDate(dateToISO(startOfWeek(anchor)))}` :
    view === "month" ? anchor.toLocaleDateString("en-IN", { month: "long", year: "numeric" }) :
    view === "year" ? String(anchor.getFullYear()) : "All items";

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h1 className="text-xl font-semibold text-slate-100">Calendar</h1>
        <FilterPills value={view} onChange={setView} options={CALENDAR_VIEWS} />
      </div>
      <p className="text-xs text-slate-600 mb-4">Computed live from your tasks, sessions, tests, and revisions — nothing is duplicated.</p>

      {view !== "agenda" && (
        <div className="flex items-center justify-between mb-4">
          <button onClick={() => nav(-1)} className="text-slate-500 hover:text-slate-200 px-2">←</button>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-slate-300">{headerLabel}</span>
            <button onClick={() => setAnchor(new Date())} className="text-xs text-indigo-400 hover:underline">Today</button>
          </div>
          <button onClick={() => nav(1)} className="text-slate-500 hover:text-slate-200 px-2">→</button>
        </div>
      )}

      {view === "day" && <DayEventList events={getEventsForDate(dateToISO(anchor), tasks, sessions, tests, revisions, questions)} />}

      {view === "week" && (() => {
        const start = startOfWeek(anchor);
        const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
        return (
          <div className="grid grid-cols-1 sm:grid-cols-7 gap-2">
            {days.map((d) => {
              const iso = dateToISO(d);
              const events = getEventsForDate(iso, tasks, sessions, tests, revisions, questions);
              const isToday = iso === todayISO();
              return (
                <button key={iso} onClick={() => jumpToDay(d)} className="text-left">
                  <Card className={`p-2 h-full ${isToday ? "border-indigo-700" : ""}`}>
                    <p className={`text-xs font-mono mb-1 ${isToday ? "text-indigo-400" : "text-slate-500"}`}>
                      {d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" })}
                    </p>
                    {events.slice(0, 3).map((e, i) => (
                      <p key={i} className="text-[11px] text-slate-400 truncate">{e.label}</p>
                    ))}
                    {events.length > 3 && <p className="text-[11px] text-slate-600">+{events.length - 3} more</p>}
                    {events.length === 0 && <p className="text-[11px] text-slate-700">—</p>}
                  </Card>
                </button>
              );
            })}
          </div>
        );
      })()}

      {view === "month" && (() => {
        const monthStart = startOfMonth(anchor);
        const gridStart = startOfWeek(monthStart);
        const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
        return (
          <div>
            <div className="grid grid-cols-7 gap-1 mb-1">
              {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d) => (
                <p key={d} className="text-[10px] text-slate-600 text-center">{d}</p>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((d) => {
                const iso = dateToISO(d);
                const events = getEventsForDate(iso, tasks, sessions, tests, revisions, questions);
                const inMonth = d.getMonth() === anchor.getMonth();
                const isToday = iso === todayISO();
                return (
                  <button key={iso} onClick={() => jumpToDay(d)}
                    className={`aspect-square rounded-lg border text-left p-1.5 flex flex-col ${
                      isToday ? "border-indigo-600 bg-indigo-950/20" : "border-slate-800"
                    } ${inMonth ? "bg-[#16161a]" : "bg-transparent opacity-40"}`}>
                    <span className={`text-xs font-mono ${isToday ? "text-indigo-400" : "text-slate-400"}`}>{d.getDate()}</span>
                    {events.length > 0 && (
                      <span className="mt-auto flex gap-0.5 flex-wrap">
                        {events.slice(0, 4).map((e, i) => (
                          <span key={i} className={`w-1.5 h-1.5 rounded-full ${CALENDAR_KIND_DOT[e.kind] || "bg-slate-400"}`} />
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {view === "year" && (() => {
        const year = anchor.getFullYear();
        const months = Array.from({ length: 12 }, (_, m) => new Date(year, m, 1));
        return (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {months.map((m) => {
              const gridStart = startOfWeek(startOfMonth(m));
              const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
              return (
                <Card key={m.getMonth()} className="p-3">
                  <button onClick={() => { setAnchor(m); setView("month"); }} className="text-xs font-semibold text-slate-300 mb-2 hover:text-indigo-400">
                    {m.toLocaleDateString("en-IN", { month: "long" })}
                  </button>
                  <div className="grid grid-cols-7 gap-0.5">
                    {cells.map((d) => {
                      const iso = dateToISO(d);
                      const has = getEventsForDate(iso, tasks, sessions, tests, revisions, questions).length > 0;
                      const inMonth = d.getMonth() === m.getMonth();
                      const isToday = iso === todayISO();
                      return (
                        <button key={iso} onClick={() => jumpToDay(d)}
                          className={`aspect-square rounded-sm text-[8px] flex items-center justify-center ${
                            !inMonth ? "text-slate-800" : isToday ? "bg-indigo-400 text-slate-950" : has ? "bg-slate-700 text-slate-300" : "text-slate-600"
                          }`}>
                          {d.getDate()}
                        </button>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>
        );
      })()}

      {view === "agenda" && (() => {
        const items = [];
        tasks.forEach((t) => items.push({ date: t.date, kind: "Task", label: t.title, sub: t.subject, done: t.status === "COMPLETED" }));
        sessions.forEach((s) => {
          const chapter = CHAPTERS.find((c) => c.id === s.chapterId);
          items.push({ date: s.date, kind: "Session", label: chapter?.name || s.subject || "Study session", sub: `${minutesToLabel(s.durationMinutes)} · ${s.type}`, done: true });
        });
        tests.forEach((t) => items.push({ date: t.date, kind: "Test", label: t.name, sub: t.series || t.status, done: t.status === "Completed" }));
        revisions.filter((r) => r.status === "SCHEDULED").forEach((r) => {
          let label = r.revisionType;
          if (r.targetType === "question") label = questions.find((q) => q.id === r.targetId)?.questionText?.slice(0, 40) || r.revisionType;
          else if (r.targetType === "chapter") label = CHAPTERS.find((c) => c.id === r.targetId)?.name || r.revisionType;
          items.push({ date: r.scheduledDate, kind: "Revision", label, sub: r.revisionType, done: false });
        });
        items.sort((a, b) => a.date.localeCompare(b.date));
        const byDate = {};
        items.forEach((i) => { (byDate[i.date] = byDate[i.date] || []).push(i); });
        const dates = Object.keys(byDate).sort();
        if (dates.length === 0) return <Card className="p-10 text-center text-sm text-slate-600">Nothing scheduled or logged yet.</Card>;
        return dates.map((d) => (
          <div key={d} className="mb-4">
            <p className="text-xs text-slate-500 font-mono mb-1.5">{formatDate(d)}</p>
            <DayEventList events={byDate[d]} />
          </div>
        ));
      })()}
    </div>
  );
}

/* ------------------------------------------------------------
   REVISION SCHEDULING (generic — any target type)
   ------------------------------------------------------------ */

function ScheduleRevisionModal({ open, onClose, targetType, targetId, onSave, revisionTypeOptions }) {
  const options = revisionTypeOptions || (targetType === "chapter" ? ["Chapter Revision", "Manual Revision"] : ["Manual Revision"]);
  const [revisionType, setRevisionType] = useState(options[0]);
  const [scheduledDate, setScheduledDate] = useState(() => dateToISO(addDays(new Date(), 1)));
  const [notes, setNotes] = useState("");
  useEffect(() => { if (open) { setRevisionType(options[0]); setScheduledDate(dateToISO(addDays(new Date(), 1))); setNotes(""); } }, [open]);

  function submit() {
    onSave({ targetType, targetId, revisionType, revisionNumber: 1, scheduledDate, status: "SCHEDULED", notes });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Schedule revision">
      <Field label="Type">
        <select className={inputClass} value={revisionType} onChange={(e) => setRevisionType(e.target.value)}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Field>
      <Field label="Scheduled date">
        <input type="date" className={inputClass} value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>Schedule</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   QUESTIONS — single normalized Question record; Important and
   Mistake are metadata fields on that SAME record. There is no
   second array anywhere: ImportantPage/MistakesPage below simply
   filter this same `questions` list.
   ------------------------------------------------------------ */

function QuestionModal({ open, onClose, initial, prefill }) {
  const { createQuestion, updateQuestion } = useAppData();
  const [form, setForm] = useState(() => initial || makeQuestion(prefill || {}));
  const [tagsText, setTagsText] = useState(() => (initial?.tags || []).join(", "));
  const [imageBusy, setImageBusy] = useState(false);
  const imageInputRef = useRef(null);
  useEffect(() => {
    if (open) { setForm(initial || makeQuestion(prefill || {})); setTagsText((initial?.tags || []).join(", ")); }
  }, [open, initial, prefill]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function setSubject(subjectId) { setForm((f) => ({ ...f, subjectId, chapterId: "", topicId: "" })); }
  function setChapter(chapterId) { setForm((f) => ({ ...f, chapterId, topicId: "" })); }
  const chapter = CHAPTERS.find((c) => c.id === form.chapterId);
  const chapterOptions = CHAPTERS.filter((c) => !form.subjectId || c.subjectId === form.subjectId);
  const valid = form.questionText.trim() && form.subjectId && form.chapterId;

  async function onImageChosen(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImageBusy(true);
    try {
      const dataUrl = await compressImageFile(file);
      set("image", dataUrl);
    } catch {
      /* silently ignore a corrupt/unreadable file — form.image stays as it was */
    } finally {
      setImageBusy(false);
    }
  }

  function submit() {
    if (!valid) return;
    const tags = tagsText.split(",").map((t) => t.trim()).filter(Boolean);
    if (initial) updateQuestion(initial.id, { ...form, tags });
    else createQuestion({ ...form, tags });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? "Edit question" : "Add question"}>
      <Field label="Question text">
        <textarea className={inputClass} rows={3} value={form.questionText} onChange={(e) => set("questionText", e.target.value)} autoFocus />
      </Field>
      <Field label="Image (optional)">
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={onImageChosen} />
        {form.image ? (
          <div className="relative">
            <img src={form.image} alt="Question" className="max-h-40 max-w-full h-auto rounded-lg border border-slate-800" />
            <div className="flex gap-2 mt-2">
              <Button variant="ghost" onClick={() => imageInputRef.current?.click()} className="!py-1 !px-2 text-xs" disabled={imageBusy}>Replace</Button>
              <Button variant="danger" onClick={() => set("image", "")} className="!py-1 !px-2 text-xs">Remove</Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" onClick={() => imageInputRef.current?.click()} disabled={imageBusy}>
            {imageBusy ? "Processing…" : "Upload image"}
          </Button>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Subject">
          <select className={inputClass} value={form.subjectId} onChange={(e) => setSubject(e.target.value)}>
            <option value="">— Select —</option>
            {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Chapter">
          <select className={inputClass} value={form.chapterId} onChange={(e) => setChapter(e.target.value)} disabled={!form.subjectId}>
            <option value="">— Select —</option>
            {chapterOptions.map((c) => <option key={c.id} value={c.id}>Class {c.classLevel} · {c.name}</option>)}
          </select>
        </Field>
      </div>
      {chapter && (
        <Field label="Topic (optional)">
          <select className={inputClass} value={form.topicId} onChange={(e) => set("topicId", e.target.value)}>
            <option value="">— None —</option>
            {chapter.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Source">
          <select className={inputClass} value={form.source} onChange={(e) => set("source", e.target.value)}>
            {QUESTION_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Difficulty">
          <select className={inputClass} value={form.difficulty} onChange={(e) => set("difficulty", e.target.value)}>
            {QUESTION_DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Correct answer">
          <input className={inputClass} value={form.correctAnswer} onChange={(e) => set("correctAnswer", e.target.value)} />
        </Field>
        <Field label="My answer">
          <input className={inputClass} value={form.myAnswer} onChange={(e) => set("myAnswer", e.target.value)} />
        </Field>
      </div>
      <Field label="Result">
        <select className={inputClass} value={form.isCorrect === null ? "" : String(form.isCorrect)}
          onChange={(e) => set("isCorrect", e.target.value === "" ? null : e.target.value === "true")}>
          <option value="">Not attempted</option>
          <option value="true">Correct</option>
          <option value="false">Incorrect</option>
        </select>
      </Field>
      <Field label="Tags (comma separated)">
        <input className={inputClass} value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
      </Field>
      <Field label="Explanation">
        <textarea className={inputClass} rows={2} value={form.explanation} onChange={(e) => set("explanation", e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      {!initial && (
        <div className="flex gap-4 mb-3">
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="w-4 h-4 accent-indigo-400" checked={form.isImportant} onChange={(e) => set("isImportant", e.target.checked)} />
            Mark as Important
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" className="w-4 h-4 accent-indigo-400" checked={form.isMistake} onChange={(e) => set("isMistake", e.target.checked)} />
            Mark as Mistake
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={!valid}>{initial ? "Save changes" : "Add question"}</Button>
      </div>
    </Modal>
  );
}

function QuestionDetailModal({ question, onClose, onOpenChapter }) {
  const { revisions, setImportant, setMistake, updateQuestion, completeRevision, deleteQuestion } = useAppData();
  const [editing, setEditing] = useState(false);
  const [mistakeTypeDraft, setMistakeTypeDraft] = useState(question.mistakeType || "Conceptual");
  const [editingMistake, setEditingMistake] = useState(false);
  const [mistakeTypeEdit, setMistakeTypeEdit] = useState(question.mistakeType || "Conceptual");
  const [mistakeNotesEdit, setMistakeNotesEdit] = useState(question.mistakeNotes || "");
  const [correctApproachEdit, setCorrectApproachEdit] = useState(question.correctApproach || "");

  const chapter = CHAPTERS.find((c) => c.id === question.chapterId);
  const subject = SUBJECTS.find((s) => s.id === question.subjectId);
  const topic = chapter?.topics.find((t) => t.id === question.topicId);
  const importantRevision = revisions.find((r) => r.targetType === "question" && r.targetId === question.id && r.revisionType === "Important Question" && r.status === "SCHEDULED");
  const mistakeRevision = revisions.find((r) => r.targetType === "question" && r.targetId === question.id && r.revisionType === "Mistake" && r.status === "SCHEDULED");

  return (
    <>
      <Modal open onClose={onClose} title="Question">
        <div className="flex flex-wrap gap-1.5 mb-3">
          <Badge>{question.difficulty}</Badge>
          <Badge>{question.source}</Badge>
          {question.isCorrect === true && <Badge tone="done">Correct</Badge>}
          {question.isCorrect === false && <Badge tone="critical">Incorrect</Badge>}
          {question.isImportant && <Badge tone="high">Important</Badge>}
          {question.isMistake && <Badge tone="critical">Mistake</Badge>}
        </div>
        <p className="text-xs text-slate-500 mb-2">{[subject?.name, chapter?.name, topic?.name].filter(Boolean).join(" · ")}</p>
        <p className="text-sm text-slate-200 mb-3 whitespace-pre-wrap">{question.questionText}</p>
        {question.image && (
          <img src={question.image} alt="Question" className="max-h-64 max-w-full h-auto rounded-lg border border-slate-800 mb-3" />
        )}
        {(question.correctAnswer || question.myAnswer) && (
          <p className="text-xs text-slate-500 mb-2">Correct: <span className="text-slate-300">{question.correctAnswer || "—"}</span> · Mine: <span className="text-slate-300">{question.myAnswer || "—"}</span></p>
        )}
        {question.explanation && <p className="text-xs text-slate-500 mb-3">{question.explanation}</p>}
        {question.tags.length > 0 && <div className="flex flex-wrap gap-1 mb-3">{question.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}

        {question.isImportant && (
          <div className="bg-[#131316] rounded-lg p-3 mb-3">
            <p className="text-xs font-semibold text-amber-300 mb-1.5">IMPORTANT</p>
            <p className="text-xs text-slate-500">Revised {question.importantRevisionCount || 0}x · Last: {formatDate(question.importantLastRevised) || "Never"} · Next: {formatDate(question.importantNextRevision) || "—"}</p>
            <div className="flex gap-2 mt-2">
              {importantRevision && <Button variant="ghost" onClick={() => completeRevision(importantRevision.id)} className="!py-1 !px-2 text-xs">Revise now</Button>}
              <Button variant="ghost" onClick={() => setImportant(question.id, false)} className="!py-1 !px-2 text-xs">Remove important</Button>
            </div>
          </div>
        )}
        {!question.isImportant && (
          <Button variant="ghost" onClick={() => setImportant(question.id, true)} className="mb-3 w-full">Mark important</Button>
        )}

        {question.isMistake && (
          <div className="bg-[#131316] rounded-lg p-3 mb-3">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-semibold text-rose-300">MISTAKE — {question.mistakeType}</p>
              <button onClick={() => { setEditingMistake((v) => !v); setMistakeTypeEdit(question.mistakeType); setMistakeNotesEdit(question.mistakeNotes); setCorrectApproachEdit(question.correctApproach); }} className="text-[11px] text-slate-500 hover:text-slate-300">
                {editingMistake ? "Cancel" : "Edit"}
              </button>
            </div>
            {editingMistake ? (
              <div className="space-y-2">
                <select className={inputClass} value={mistakeTypeEdit} onChange={(e) => setMistakeTypeEdit(e.target.value)}>
                  {MISTAKE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <textarea className={inputClass} rows={2} placeholder="What went wrong" value={mistakeNotesEdit} onChange={(e) => setMistakeNotesEdit(e.target.value)} />
                <textarea className={inputClass} rows={2} placeholder="Correct approach" value={correctApproachEdit} onChange={(e) => setCorrectApproachEdit(e.target.value)} />
                <Button variant="ghost" onClick={() => { updateQuestion(question.id, { mistakeType: mistakeTypeEdit, mistakeNotes: mistakeNotesEdit, correctApproach: correctApproachEdit }); setEditingMistake(false); }} className="!py-1 !px-2 text-xs">Save</Button>
              </div>
            ) : (
              <>
                {question.mistakeNotes && <p className="text-xs text-slate-400 mb-1">What went wrong: {question.mistakeNotes}</p>}
                {question.correctApproach && <p className="text-xs text-slate-400 mb-1">Correct approach: {question.correctApproach}</p>}
                <p className="text-xs text-slate-500">Revised {question.mistakeRevisionCount || 0}x · Last: {formatDate(question.mistakeLastRevised) || "Never"} · Next: {formatDate(question.mistakeNextRevision) || "—"}</p>
              </>
            )}
            <div className="flex gap-2 mt-2">
              {mistakeRevision && <Button variant="ghost" onClick={() => completeRevision(mistakeRevision.id)} className="!py-1 !px-2 text-xs">Revise now</Button>}
              <Button variant="ghost" onClick={() => setMistake(question.id, false)} className="!py-1 !px-2 text-xs">Remove mistake</Button>
            </div>
          </div>
        )}
        {!question.isMistake && (
          <div className="mb-3">
            <div className="flex gap-2">
              <select className={inputClass} value={mistakeTypeDraft} onChange={(e) => setMistakeTypeDraft(e.target.value)}>
                {MISTAKE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <Button variant="ghost" onClick={() => setMistake(question.id, true, { mistakeType: mistakeTypeDraft })} className="whitespace-nowrap">Mark mistake</Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 mt-2">
          <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
          {chapter && <Button variant="ghost" onClick={() => { onOpenChapter && onOpenChapter(chapter.id); onClose(); }}>Open chapter</Button>}
          <Button variant="danger" onClick={() => { deleteQuestion(question.id); onClose(); }}>Delete</Button>
        </div>
      </Modal>
      <QuestionModal open={editing} onClose={() => setEditing(false)} initial={question} />
    </>
  );
}

function QuestionRow({ question, onClick }) {
  const chapter = CHAPTERS.find((c) => c.id === question.chapterId);
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30 text-left">
      {question.image && <img src={question.image} alt="" className="w-10 h-10 rounded object-cover border border-slate-800 flex-shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200 truncate">{question.questionText || "(no text)"}</p>
        <p className="text-xs text-slate-600 mt-0.5">{[chapter?.name, question.source].filter(Boolean).join(" · ")}</p>
      </div>
      {question.isImportant && <Badge tone="high">★</Badge>}
      {question.isMistake && <Badge tone="critical">✕</Badge>}
      <Badge>{question.difficulty}</Badge>
    </button>
  );
}

const QUESTION_SORTS = [
  { id: "recent", label: "Recently added" },
  { id: "alpha", label: "Alphabetical" },
];

function QuestionsPage({ initialOpenId, onConsumedInitial }) {
  const { questions } = useAppData();
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [chapterFilter, setChapterFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [difficultyFilter, setDifficultyFilter] = useState("all");
  const [importantOnly, setImportantOnly] = useState(false);
  const [mistakeOnly, setMistakeOnly] = useState(false);
  const [sortBy, setSortBy] = useState("recent");
  const [showAdd, setShowAdd] = useState(false);
  const [openQuestion, setOpenQuestion] = useState(null);

  useEffect(() => {
    if (initialOpenId) {
      const q = questions.find((x) => x.id === initialOpenId);
      if (q) setOpenQuestion(q);
      onConsumedInitial && onConsumedInitial();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOpenId]);

  const chapterOptions = subjectFilter === "all" ? CHAPTERS : CHAPTERS.filter((c) => c.subjectId === subjectFilter);

  let filtered = questions.filter((q) =>
    (!search || q.questionText.toLowerCase().includes(search.toLowerCase()) || q.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()))) &&
    (subjectFilter === "all" || q.subjectId === subjectFilter) &&
    (chapterFilter === "all" || q.chapterId === chapterFilter) &&
    (sourceFilter === "all" || q.source === sourceFilter) &&
    (difficultyFilter === "all" || q.difficulty === difficultyFilter) &&
    (!importantOnly || q.isImportant) && (!mistakeOnly || q.isMistake)
  );
  filtered = [...filtered].sort((a, b) => sortBy === "alpha" ? a.questionText.localeCompare(b.questionText) : b.dateAdded.localeCompare(a.dateAdded));

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <p className="text-xs text-slate-500 font-medium tracking-wide">QUESTIONS</p>
          <h1 className="text-xl font-semibold text-slate-100 mt-1">{questions.length} questions</h1>
        </div>
        <Button onClick={() => setShowAdd(true)} className="flex items-center gap-1"><Plus size={14} /> Add question</Button>
      </div>

      <div className="flex items-center gap-2 bg-[#16161a] border border-slate-800 rounded-lg px-3 py-2 mb-4 max-w-sm">
        <Search size={14} className="text-slate-600" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search question text or tags"
          className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none w-full" />
      </div>

      <div className="flex flex-wrap gap-2 mb-4 text-xs">
        <select value={subjectFilter} onChange={(e) => { setSubjectFilter(e.target.value); setChapterFilter("all"); }} className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All subjects</option>
          {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={chapterFilter} onChange={(e) => setChapterFilter(e.target.value)} className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All chapters</option>
          {chapterOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All sources</option>
          {QUESTION_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={difficultyFilter} onChange={(e) => setDifficultyFilter(e.target.value)} className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400">
          <option value="all">All difficulties</option>
          {QUESTION_DIFFICULTIES.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <FilterPills value={importantOnly ? "yes" : "no"} onChange={(v) => setImportantOnly(v === "yes")} options={[{ id: "no", label: "All" }, { id: "yes", label: "Important only" }]} />
        <FilterPills value={mistakeOnly ? "yes" : "no"} onChange={(v) => setMistakeOnly(v === "yes")} options={[{ id: "no", label: "All" }, { id: "yes", label: "Mistakes only" }]} />
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="bg-[#16161a] border border-slate-800 rounded-full px-3 py-1 text-slate-400 ml-auto">
          {QUESTION_SORTS.map((o) => <option key={o.id} value={o.id}>Sort: {o.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-600">
          {questions.length === 0 ? "No questions added yet." : "No questions match these filters."}
        </Card>
      ) : (
        <Card>{filtered.map((q) => <QuestionRow key={q.id} question={q} onClick={() => setOpenQuestion(q)} />)}</Card>
      )}

      <QuestionModal open={showAdd} onClose={() => setShowAdd(false)} />
      {openQuestion && <QuestionDetailModal question={openQuestion} onClose={() => setOpenQuestion(null)} />}
    </div>
  );
}

function ImportantPage() {
  const { questions } = useAppData();
  const [openQuestion, setOpenQuestion] = useState(null);
  const important = questions.filter((q) => q.isImportant)
    .sort((a, b) => (a.importantNextRevision || "9999").localeCompare(b.importantNextRevision || "9999"));

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold text-slate-100 mb-1">Important questions</h1>
      <p className="text-xs text-slate-600 mb-4">{important.length} marked important</p>
      {important.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-600">No important questions yet. Mark one from the Questions page or a question's detail view.</Card>
      ) : (
        <Card>{important.map((q) => <QuestionRow key={q.id} question={q} onClick={() => setOpenQuestion(q)} />)}</Card>
      )}
      {openQuestion && <QuestionDetailModal question={openQuestion} onClose={() => setOpenQuestion(null)} />}
    </div>
  );
}

function MistakesPage() {
  const { questions } = useAppData();
  const [openQuestion, setOpenQuestion] = useState(null);
  const mistakes = questions.filter((q) => q.isMistake)
    .sort((a, b) => (a.mistakeNextRevision || "9999").localeCompare(b.mistakeNextRevision || "9999"));

  const typeCounts = {};
  const chapterCounts = {};
  mistakes.forEach((q) => {
    typeCounts[q.mistakeType] = (typeCounts[q.mistakeType] || 0) + 1;
    const chapter = CHAPTERS.find((c) => c.id === q.chapterId);
    if (chapter) chapterCounts[chapter.name] = (chapterCounts[chapter.name] || 0) + 1;
  });
  const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topChapters = Object.entries(chapterCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold text-slate-100 mb-1">Mistake book</h1>
      <p className="text-xs text-slate-600 mb-4">{mistakes.length} logged mistakes</p>

      {mistakes.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          <Card className="p-3">
            <p className="text-xs text-slate-500 mb-2">Mistake type distribution</p>
            {topTypes.map(([t, c]) => (
              <div key={t} className="flex justify-between text-xs text-slate-400 py-0.5"><span>{t}</span><span className="font-mono">{c}</span></div>
            ))}
          </Card>
          <Card className="p-3">
            <p className="text-xs text-slate-500 mb-2">Chapters with most mistakes</p>
            {topChapters.map(([c, n]) => (
              <div key={c} className="flex justify-between text-xs text-slate-400 py-0.5"><span className="truncate">{c}</span><span className="font-mono">{n}</span></div>
            ))}
          </Card>
        </div>
      )}

      {mistakes.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-600">No mistakes logged yet. Mark one from the Questions page or a question's detail view.</Card>
      ) : (
        <Card>{mistakes.map((q) => <QuestionRow key={q.id} question={q} onClick={() => setOpenQuestion(q)} />)}</Card>
      )}
      {openQuestion && <QuestionDetailModal question={openQuestion} onClose={() => setOpenQuestion(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------
   GLOBAL SEARCH — searches every entity that actually exists:
   chapters/topics, questions (text/tags/source/mistake notes/
   correct approach/explanation), resources, tasks, study sessions.
   Tests/Backlog/Revisions-as-text aren't included because those
   aren't separate searchable text records (Tests don't exist yet;
   Revisions have no free text worth matching beyond their target,
   which is already covered via the question/chapter it points to).
   ------------------------------------------------------------ */

function GlobalSearch({ onOpenChapter, onOpenQuestion, onOpenTest, onGoRoute }) {
  const { questions, resources, lectures, tasks, sessions, tests, testSyllabus, testAnalysis } = useAppData();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const q = query.trim().toLowerCase();
  const results = q.length < 2 ? [] : (() => {
    const out = [];
    CHAPTERS.forEach((c) => {
      if (c.name.toLowerCase().includes(q)) out.push({ type: "Chapter", label: c.name, onClick: () => onOpenChapter(c.id) });
      c.topics.forEach((t) => { if (t.name.toLowerCase().includes(q)) out.push({ type: "Topic", label: `${t.name} (${c.name})`, onClick: () => onOpenChapter(c.id) }); });
    });
    questions.forEach((qn) => {
      const hay = [qn.questionText, ...(qn.tags || []), qn.source, qn.mistakeNotes, qn.correctApproach, qn.explanation].join(" ").toLowerCase();
      if (hay.includes(q)) out.push({ type: "Question", label: qn.questionText.slice(0, 60) || "(no text)", onClick: () => onOpenQuestion(qn) });
    });
    resources.forEach((r) => { if (r.name.toLowerCase().includes(q)) out.push({ type: "Resource", label: r.name, onClick: () => onGoRoute("resources") }); });
    lectures.forEach((l) => {
      if (l.title.toLowerCase().includes(q)) {
        const chapter = CHAPTERS.find((c) => c.id === l.chapterId);
        out.push({ type: "Lecture", label: l.title, onClick: () => chapter ? onOpenChapter(chapter.id) : onGoRoute("resources") });
      }
    });
    tasks.forEach((t) => {
      if (t.title.toLowerCase().includes(q)) {
        const backlog = isBacklogTask(t, todayISO());
        out.push({ type: backlog ? "Backlog" : "Task", label: t.title, onClick: () => onGoRoute(backlog ? "backlog" : "dashboard") });
      }
    });
    sessions.forEach((s) => {
      const chapter = CHAPTERS.find((c) => c.id === s.chapterId);
      const label = chapter?.name || s.subject;
      if (label && label.toLowerCase().includes(q)) out.push({ type: "Session", label, onClick: () => onGoRoute("sessions") });
    });
    tests.forEach((t) => {
      const hay = [t.testNumber, t.name, t.series].join(" ").toLowerCase();
      if (hay.includes(q)) out.push({ type: "Test", label: t.name, onClick: () => onOpenTest(t.id) });
    });
    testSyllabus.forEach((s) => {
      const chapter = CHAPTERS.find((c) => c.id === s.chapterId);
      const topic = chapter?.topics.find((t) => t.id === s.topicId);
      const hay = [chapter?.name, topic?.name].filter(Boolean).join(" ").toLowerCase();
      if (hay && hay.includes(q)) {
        const test = tests.find((t) => t.id === s.testId);
        if (test) out.push({ type: "Test syllabus", label: `${chapter.name} in ${test.name}`, onClick: () => onOpenTest(test.id) });
      }
    });
    testAnalysis.forEach((a) => {
      const hay = [a.mistakeType, a.correctApproach, a.notes].filter(Boolean).join(" ").toLowerCase();
      if (hay.includes(q)) {
        const test = tests.find((t) => t.id === a.testId);
        const question = questions.find((qq) => qq.id === a.questionId);
        if (test) out.push({ type: "Test analysis", label: `${question?.questionText.slice(0, 40) || a.mistakeType} (${test.name})`, onClick: () => onOpenTest(test.id) });
      }
    });
    return out.slice(0, 8);
  })();

  return (
    <div className="relative flex-1 min-w-0 max-w-sm">
      <div className="flex items-center gap-2 bg-[#16161a] border border-slate-800 rounded-lg px-3 py-1.5">
        <Search size={14} className="text-slate-600" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search chapters, questions, tasks…"
          className="bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none w-full"
        />
      </div>
      {open && q.length >= 2 && (
        <div className="absolute left-0 right-0 mt-1 bg-[#1c1c20] border border-slate-800 rounded-xl shadow-xl z-40 overflow-hidden max-h-80 overflow-y-auto">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-xs text-slate-600">No matches.</p>
          ) : (
            results.map((r, i) => (
              <button key={i} onClick={() => { r.onClick(); setOpen(false); setQuery(""); }}
                className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-slate-800/60">
                <Badge>{r.type}</Badge>
                <span className="text-sm text-slate-300 truncate">{r.label}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------
   TESTS
   ------------------------------------------------------------ */

function TestModal({ open, onClose, initial }) {
  const { createTest, updateTest } = useAppData();
  const [form, setForm] = useState(() => initial || makeTest({}));
  useEffect(() => { if (open) setForm(initial || makeTest({})); }, [open, initial]);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function submit() {
    if (!form.name.trim()) return;
    if (initial) updateTest(initial.id, form);
    else createTest(form);
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? "Edit test" : "New test"}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Test number">
          <input className={inputClass} value={form.testNumber} onChange={(e) => set("testNumber", e.target.value)} />
        </Field>
        <Field label="Series">
          <input className={inputClass} value={form.series} placeholder="e.g. AITS, NEET, Rank Booster" onChange={(e) => set("series", e.target.value)} />
        </Field>
      </div>
      <Field label="Name">
        <input className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} autoFocus />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">
          <input type="date" className={inputClass} value={form.date} onChange={(e) => set("date", e.target.value)} />
        </Field>
        <Field label="Max score">
          <input type="number" className={inputClass} value={form.maxScore} onChange={(e) => set("maxScore", safeNumber(e.target.value, 720))} />
        </Field>
      </div>
      <Field label="Status">
        <select className={inputClass} value={form.status} onChange={(e) => set("status", e.target.value)}>
          {TEST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="Notes">
        <textarea className={inputClass} rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>{initial ? "Save changes" : "Create test"}</Button>
      </div>
    </Modal>
  );
}

function TestImportModal({ open, onClose }) {
  const { createTest } = useAppData();
  const [stage, setStage] = useState("paste"); // paste -> preview/edit -> done
  const [raw, setRaw] = useState("");
  const [rows, setRows] = useState([]);

  useEffect(() => { if (open) { setStage("paste"); setRaw(""); setRows([]); } }, [open]);

  function parse() {
    const parsed = raw.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
      const [testNumber, name, date, series] = line.split(",").map((c) => (c || "").trim());
      return { testNumber: testNumber || "", name: name || "", date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "", series: series || "", valid: !!name && /^\d{4}-\d{2}-\d{2}$/.test(date) };
    });
    setRows(parsed);
    setStage("preview");
  }

  function updateRow(i, patch) { setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch, valid: !!(patch.name ?? r.name) && /^\d{4}-\d{2}-\d{2}$/.test(patch.date ?? r.date) } : r))); }
  function removeRow(i) { setRows((prev) => prev.filter((_, idx) => idx !== i)); }

  function approve() {
    rows.filter((r) => r.valid).forEach((r) => createTest({ testNumber: r.testNumber, name: r.name, date: r.date, series: r.series }));
    setStage("done");
  }

  return (
    <Modal open={open} onClose={onClose} title="Import tests">
      {stage === "paste" && (
        <>
          <p className="text-xs text-slate-500 mb-2">Paste one test per line: <span className="font-mono text-slate-400">test number, name, date (YYYY-MM-DD), series</span></p>
          <textarea className={inputClass} rows={6} value={raw} onChange={(e) => setRaw(e.target.value)}
            placeholder={"9, Rank Booster Test-2, 2026-08-23, Lakshya NEET 2027"} />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={parse} disabled={!raw.trim()}>Preview</Button>
          </div>
        </>
      )}
      {stage === "preview" && (
        <>
          <p className="text-xs text-slate-500 mb-2">Review and edit before saving — nothing is saved yet.</p>
          <div className="space-y-2 max-h-72 overflow-y-auto mb-3">
            {rows.map((r, i) => (
              <div key={i} className={`p-2 rounded-lg border ${r.valid ? "border-slate-800" : "border-rose-900 bg-rose-950/20"}`}>
                <div className="grid grid-cols-4 gap-1.5">
                  <input className={inputClass + " !py-1 text-xs"} value={r.testNumber} onChange={(e) => updateRow(i, { testNumber: e.target.value })} placeholder="No." />
                  <input className={inputClass + " !py-1 text-xs col-span-2"} value={r.name} onChange={(e) => updateRow(i, { name: e.target.value })} placeholder="Name" />
                  <input className={inputClass + " !py-1 text-xs"} value={r.date} onChange={(e) => updateRow(i, { date: e.target.value })} placeholder="YYYY-MM-DD" />
                </div>
                <div className="flex items-center justify-between mt-1">
                  {!r.valid && <span className="text-[10px] text-rose-400">Needs a name and a valid YYYY-MM-DD date</span>}
                  <button onClick={() => removeRow(i)} className="text-[10px] text-slate-600 hover:text-rose-400 ml-auto">Remove</button>
                </div>
              </div>
            ))}
            {rows.length === 0 && <p className="text-xs text-slate-600">No rows.</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStage("paste")}>Back</Button>
            <Button onClick={approve} disabled={rows.every((r) => !r.valid)}>Approve & save {rows.filter((r) => r.valid).length} test(s)</Button>
          </div>
        </>
      )}
      {stage === "done" && (
        <>
          <p className="text-sm text-slate-300 mb-4">Imported {rows.filter((r) => r.valid).length} test(s).</p>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------
   REAL TEST SCHEDULE IMPORT — imports the two supplied source
   planners (NEETprep VITAL, PW Lakshya) into the existing
   Test/TestSyllabus entities. Upload/Use source → Extract →
   Preview → Validate → Edit → Approve → Save. Nothing is saved
   until Approve; duplicate tests (same series + test number) are
   detected and handled per-row (Update Existing / Skip), never
   silently duplicated.
   ------------------------------------------------------------ */

function buildSchedulePreview(plannerKey, existingTests) {
  const planner = IMPORT_SOURCE_PLANNERS[plannerKey];
  return planner.tests.map((t) => {
    const existing = existingTests.find((et) => et.sourcePlanner === planner.series && et.sourceTestNumber === t.testNumber);
    const bySection = { Physics: [], Chemistry: [], Botany: [], Zoology: [] };
    let needsReview = false;
    t.syllabus.forEach((s) => {
      const chapter = matchChapterName(s.chapterName);
      const unclear = s.section === "UNCLEAR";
      // NEETprep's planner never splits Biology into Botany/Zoology at all —
      // that's a deliberate planner convention, not an extraction failure,
      // so it uses the app's own Botany/Zoology classification without
      // being flagged for review (unlike a genuinely UNCLEAR merged column).
      const genericBiology = s.section === "Biology";
      const section = (unclear || genericBiology) ? sectionForChapter(chapter || { subjectId: "biology", id: "" }) : s.section;
      if (!chapter || unclear) needsReview = true;
      bySection[section] = bySection[section] || [];
      bySection[section].push({ sourceName: s.chapterName, chapter, unclearSection: unclear });
    });
    return { ...t, series: planner.series, sourcePlanner: planner.series, bySection, needsReview, existing };
  });
}

function TestScheduleImportModal({ open, onClose }) {
  const { tests, testSyllabus, createTest, updateTest, addTestSyllabusEntry } = useAppData();
  const [plannerKey, setPlannerKey] = useState("neetprep_vital");
  const [stage, setStage] = useState("select"); // select -> preview -> done
  const [rowActions, setRowActions] = useState({}); // testNumber -> "create" | "update" | "skip"
  const [included, setIncluded] = useState({}); // testNumber -> bool

  useEffect(() => {
    if (open) { setStage("select"); setRowActions({}); setIncluded({}); }
  }, [open]);

  const preview = stage === "preview" ? buildSchedulePreview(plannerKey, tests) : [];

  function goPreview() {
    const rows = buildSchedulePreview(plannerKey, tests);
    const actions = {}; const inc = {};
    rows.forEach((r) => { actions[r.testNumber] = r.existing ? "update" : "create"; inc[r.testNumber] = true; });
    setRowActions(actions); setIncluded(inc);
    setStage("preview");
  }

  function approve() {
    preview.forEach((row) => {
      if (!included[row.testNumber]) return;
      const action = rowActions[row.testNumber];
      if (action === "skip") return;

      let testId;
      if (action === "update" && row.existing) {
        testId = row.existing.id;
        updateTest(testId, { name: row.name, date: row.date, series: row.series, notes: row.notes, sourcePlanner: row.sourcePlanner, sourceTestNumber: row.testNumber });
      } else {
        const created = createTest({ testNumber: row.testNumber, name: row.name, date: row.date, series: row.series, notes: row.notes, sourcePlanner: row.sourcePlanner, sourceTestNumber: row.testNumber });
        testId = created?.id;
      }
      if (!testId) return;

      const existingChapterIds = new Set(testSyllabus.filter((s) => s.testId === testId).map((s) => s.chapterId));
      Object.values(row.bySection).flat().forEach((entry) => {
        if (!entry.chapter || existingChapterIds.has(entry.chapter.id)) return; // unresolved or already-linked — never a broken/duplicate reference
        addTestSyllabusEntry({ testId, subjectId: entry.chapter.subjectId, chapterId: entry.chapter.id, topicId: "", section: sectionForChapter(entry.chapter) });
      });
    });
    setStage("done");
  }

  const includedCount = Object.values(included).filter(Boolean).length;
  const planner = IMPORT_SOURCE_PLANNERS[plannerKey];

  return (
    <Modal open={open} onClose={onClose} title="Import real test schedule">
      {stage === "select" && (
        <>
          <p className="text-xs text-slate-500 mb-3">Imports tests directly from the source planners you supplied — not a generic schedule.</p>
          <div className="space-y-2 mb-4">
            {Object.entries(IMPORT_SOURCE_PLANNERS).map(([key, p]) => (
              <label key={key} className="flex items-center gap-2 p-2 rounded-lg border border-slate-800 cursor-pointer">
                <input type="radio" name="planner" checked={plannerKey === key} onChange={() => setPlannerKey(key)} className="accent-indigo-400" />
                <span className="text-sm text-slate-300">{p.label}</span>
                <span className="text-xs text-slate-600 ml-auto">{p.tests.length} tests</span>
              </label>
            ))}
          </div>
          {planner.skippedNote && (
            <div className="bg-amber-950/40 border border-amber-900 rounded-lg px-3 py-2 mb-3">
              <p className="text-xs text-amber-200">⚠️ {planner.skippedNote}</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={goPreview}>Extract & preview</Button>
          </div>
        </>
      )}

      {stage === "preview" && (
        <>
          <p className="text-xs text-slate-500 mb-3">Nothing is saved yet. Uncheck rows to exclude them, or choose an action for duplicates.</p>
          <div className="space-y-2 max-h-96 overflow-y-auto mb-3">
            {preview.map((row) => (
              <div key={row.testNumber} className={`p-2 rounded-lg border ${row.needsReview ? "border-amber-900 bg-amber-950/20" : "border-slate-800"}`}>
                <div className="flex items-center gap-2 mb-1">
                  <input type="checkbox" checked={!!included[row.testNumber]} onChange={(e) => setIncluded((prev) => ({ ...prev, [row.testNumber]: e.target.checked }))} className="accent-indigo-400" />
                  <span className="text-sm text-slate-200">#{row.testNumber} · {row.name}</span>
                  <span className="text-xs text-slate-600">{formatDate(row.date)}</span>
                  {row.needsReview && <Badge tone="high">⚠️ NEEDS REVIEW</Badge>}
                  {row.existing && (
                    <select value={rowActions[row.testNumber]} onChange={(e) => setRowActions((prev) => ({ ...prev, [row.testNumber]: e.target.value }))}
                      className="ml-auto bg-[#131316] border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-300">
                      <option value="update">Already exists — Update existing</option>
                      <option value="skip">Already exists — Skip</option>
                    </select>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-[11px] text-slate-500 pl-6">
                  {TEST_SECTIONS.map((sec) => (
                    <div key={sec}>
                      <span className="text-slate-600">{sec}: </span>
                      {(row.bySection[sec] || []).length === 0 ? "—" : row.bySection[sec].map((e, i) => (
                        <span key={i} className={e.chapter && !e.unclearSection ? "" : "text-amber-400"}>
                          {e.chapter ? e.chapter.name : `"${e.sourceName}" (unmatched)`}{i < row.bySection[sec].length - 1 ? ", " : ""}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
                {row.notes && <p className="text-[11px] text-slate-600 pl-6 mt-1">{row.notes}</p>}
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStage("select")}>Back</Button>
            <Button onClick={approve} disabled={includedCount === 0}>Approve & save {includedCount} test(s)</Button>
          </div>
        </>
      )}

      {stage === "done" && (
        <>
          <p className="text-sm text-slate-300 mb-4">Import complete.</p>
          <div className="flex justify-end"><Button onClick={onClose}>Done</Button></div>
        </>
      )}
    </Modal>
  );
}

function TestRow({ test, onClick, testSyllabus, tasks, sessions, lectures, resources, questions, revisions, chapterProgress = {} }) {
  const daysRemaining = localDaysBetween(todayISO(), test.date);
  const chapterIds = testSyllabus.filter((s) => s.testId === test.id).map((s) => s.chapterId);
  const overall = chapterIds.length ? Math.round(chapterIds.reduce((s, id) => s + getChapterReadiness(id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress).readiness, 0) / chapterIds.length) : null;
  const statusTone = { Upcoming: "medium", Completed: "done", Missed: "critical", Cancelled: "neutral" }[test.status];

  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30 text-left flex-wrap">
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200 truncate">{test.testNumber ? `#${test.testNumber} · ` : ""}{test.name}</p>
        <p className="text-xs text-slate-600 mt-0.5">{test.series} · {formatDate(test.date)} · {chapterIds.length} chapters</p>
      </div>
      {test.status === "Upcoming" && (
        <span className="text-xs font-mono text-slate-400">{daysRemaining >= 0 ? `${daysRemaining}d left` : `${-daysRemaining}d overdue`}</span>
      )}
      {overall !== null && <span className="text-xs font-mono text-indigo-400">{overall}% ready</span>}
      <Badge tone={statusTone}>{test.status}</Badge>
    </button>
  );
}

function TestsPage({ onOpenTest }) {
  const { tests, testSyllabus, tasks, sessions, lectures, resources, questions, revisions, chapterProgress, createTest, deleteTest } = useAppData();
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showScheduleImport, setShowScheduleImport] = useState(false);
  const sorted = [...tests].sort((a, b) => a.date.localeCompare(b.date));

  function duplicate(test) {
    createTest({ ...test, id: undefined, name: `${test.name} (copy)`, status: "Upcoming", score: null, correct: null, wrong: null, unattempted: null, accuracy: null, subjectScores: { physics: null, chemistry: null, biology: null } });
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <p className="text-xs text-slate-500 font-medium tracking-wide">TESTS</p>
          <h1 className="text-xl font-semibold text-slate-100 mt-1">{tests.length} tests</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setShowScheduleImport(true)}>Import real schedule</Button>
          <Button variant="ghost" onClick={() => setShowImport(true)}>Import (manual paste)</Button>
          <Button onClick={() => setShowAdd(true)} className="flex items-center gap-1"><Plus size={14} /> New test</Button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-600">No tests added yet.</Card>
      ) : (
        <Card>
          {sorted.map((t) => (
            <div key={t.id} className="flex items-center">
              <div className="flex-1">
                <TestRow test={t} onClick={() => onOpenTest(t.id)} testSyllabus={testSyllabus} tasks={tasks} sessions={sessions} lectures={lectures} resources={resources} questions={questions} revisions={revisions} chapterProgress={chapterProgress} />
              </div>
              <div className="flex gap-1 px-2">
                <button onClick={() => duplicate(t)} className="text-[11px] text-slate-600 hover:text-slate-300 px-1">Duplicate</button>
                <button onClick={() => deleteTest(t.id)} className="text-[11px] text-slate-600 hover:text-rose-400 px-1">Delete</button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <TestModal open={showAdd} onClose={() => setShowAdd(false)} />
      <TestImportModal open={showImport} onClose={() => setShowImport(false)} />
      <TestScheduleImportModal open={showScheduleImport} onClose={() => setShowScheduleImport(false)} />

      {/* TEST PERFORMANCE HISTORY — completed tests only, newest first, no fabricated rows */}
      {(() => {
        const completed = [...tests].filter((t) => t.status === "Completed").sort((a, b) => b.date.localeCompare(a.date));
        if (completed.length === 0) return null;
        return (
          <div className="mt-8">
            <p className="text-xs text-slate-500 font-medium tracking-wide mb-3">TEST HISTORY</p>
            <Card className="overflow-x-auto">
              <table className="w-full text-xs min-w-[560px]">
                <thead>
                  <tr className="text-slate-600 text-left border-b border-slate-800">
                    <th className="px-3 py-2 font-medium">Test</th>
                    <th className="px-3 py-2 font-medium">Date</th>
                    <th className="px-3 py-2 font-medium">Score</th>
                    <th className="px-3 py-2 font-medium">%</th>
                    <th className="px-3 py-2 font-medium">Accuracy</th>
                    <th className="px-3 py-2 font-medium">Physics</th>
                    <th className="px-3 py-2 font-medium">Chemistry</th>
                    <th className="px-3 py-2 font-medium">Biology</th>
                  </tr>
                </thead>
                <tbody>
                  {completed.map((t) => (
                    <tr key={t.id} className="border-b border-slate-800/50 last:border-0 hover:bg-slate-800/30 cursor-pointer" onClick={() => onOpenTest(t.id)}>
                      <td className="px-3 py-2 text-slate-300 truncate max-w-[160px]">{t.name}</td>
                      <td className="px-3 py-2 text-slate-500">{formatDate(t.date)}</td>
                      <td className="px-3 py-2 font-mono text-slate-300">{t.score ?? "—"}/{t.maxScore}</td>
                      <td className="px-3 py-2 font-mono text-slate-400">{t.score != null ? `${Math.round((t.score / t.maxScore) * 100)}%` : "—"}</td>
                      <td className="px-3 py-2 font-mono text-slate-400">{t.accuracy ?? "—"}%</td>
                      <td className="px-3 py-2 font-mono text-slate-500">{t.subjectScores?.physics ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-slate-500">{t.subjectScores?.chemistry ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-slate-500">{t.subjectScores?.biology ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        );
      })()}
    </div>
  );
}



/* ------------------------------------------------------------
   TEST DETAIL
   ------------------------------------------------------------ */

function TestDetailPage({ testId, onBack, onOpenChapter, onOpenQuestion }) {
  const {
    tests, testSyllabus, testAnalysis, tasks, sessions, lectures, resources, questions, revisions, chapterProgress,
    updateTest, deleteTest, setTestResult, addTestSyllabusEntry, removeTestSyllabusEntry,
    createTask, createTestAnalysis, linkTestAnalysisTask, setImportant, setMistake, completeRevision,
  } = useAppData();

  const test = tests.find((t) => t.id === testId);
  const [addSubjectId, setAddSubjectId] = useState("physics");
  const [addChapterId, setAddChapterId] = useState("");
  const [addTopicId, setAddTopicId] = useState("");
  const [showResult, setShowResult] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [suggestTask, setSuggestTask] = useState(null);
  const [analysisTaskPrefill, setAnalysisTaskPrefill] = useState(null);
  const [analysisTaskForId, setAnalysisTaskForId] = useState(null);
  const [dismissed, setDismissed] = useState(new Set());

  if (!test) return <EmptyState label="test not found" message="Test not found." />;

  const mySyllabus = testSyllabus.filter((s) => s.testId === testId);
  const chapterIds = mySyllabus.map((s) => s.chapterId);
  const daysRemaining = localDaysBetween(todayISO(), test.date);
  const prep = getPreparationMode(daysRemaining);

  const bySection = TEST_SECTIONS.reduce((acc, sec) => {
    acc[sec] = mySyllabus.filter((s) => s.section === sec);
    return acc;
  }, {});

  const physicsReadiness = getSubjectReadiness(bySection.Physics.map((s) => s.chapterId), tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
  const chemistryReadiness = getSubjectReadiness(bySection.Chemistry.map((s) => s.chapterId), tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
  const biologyChapterIds = [...bySection.Botany, ...bySection.Zoology].map((s) => s.chapterId);
  const biologyReadiness = getSubjectReadiness(biologyChapterIds, tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
  const overallReadiness = chapterIds.length
    ? Math.round(chapterIds.reduce((s, id) => s + getChapterReadiness(id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress).readiness, 0) / chapterIds.length)
    : null;

  const chapterReadinessList = chapterIds.map((id) => ({ chapter: CHAPTERS.find((c) => c.id === id), ...getChapterReadiness(id, tasks, sessions, lectures, resources, questions, revisions, chapterProgress) })).filter((c) => c.chapter);
  const weakChapters = chapterReadinessList.filter((c) => getChapterStatus(c.stats, c.checklist) === "WEAK");

  const aggCorrect = chapterReadinessList.reduce((s, c) => s + c.stats.qCorrect, 0);
  const aggIncorrect = chapterReadinessList.reduce((s, c) => s + c.stats.qIncorrect, 0);
  const aggQCount = chapterReadinessList.reduce((s, c) => s + c.stats.qCount, 0);
  const aggAccuracy = Math.round(safeDiv(aggCorrect, aggCorrect + aggIncorrect) * 100);
  const aggMistakes = chapterReadinessList.reduce((s, c) => s + c.stats.mistakeCount, 0);
  const aggRevisionsDue = chapterReadinessList.reduce((s, c) => s + c.stats.revisionsDueCount, 0);

  const linkedTasks = tasks.filter((t) => chapterIds.includes(t.chapterId));
  const chapterQuestionSet = questions.filter((q) => chapterIds.includes(q.chapterId));
  const myAnalysis = testAnalysis.filter((a) => a.testId === testId);
  const completedTests = tests.filter((t) => t.status === "Completed" && t.id !== testId).sort((a, b) => b.date.localeCompare(a.date));

  // Subject-level question accuracy (distinct from the test-level subjectScores
  // entered by hand) — computed only from chapters actually in this section.
  function sectionAccuracy(ids) {
    if (ids.length === 0) return null;
    const rows = chapterReadinessList.filter((c) => ids.includes(c.chapter.id));
    const correct = rows.reduce((s, c) => s + c.stats.qCorrect, 0);
    const incorrect = rows.reduce((s, c) => s + c.stats.qIncorrect, 0);
    if (correct + incorrect === 0) return null;
    return Math.round(safeDiv(correct, correct + incorrect) * 100);
  }
  const physicsAccuracy = sectionAccuracy(bySection.Physics.map((s) => s.chapterId));
  const chemistryAccuracy = sectionAccuracy(bySection.Chemistry.map((s) => s.chapterId));
  const biologyAccuracy = sectionAccuracy(biologyChapterIds);

  // Score trend vs. the most recent PRIOR completed test (by date, not just list order).
  const priorTest = completedTests.filter((t) => t.date < test.date).sort((a, b) => b.date.localeCompare(a.date))[0];
  const scoreTrend = test.status === "Completed" && priorTest && priorTest.score != null && test.score != null
    ? test.score - priorTest.score : null;

  // Wrong-question chapter performance and repeated-mistake patterns — this test's own data only.
  const chapterPerformance = test.status === "Completed"
    ? getChapterPerformanceForTest(myAnalysis, questions, tasks, sessions, lectures, resources, questions, revisions, chapterProgress)
    : [];
  const myMistakeQuestionIds = new Set(myAnalysis.map((a) => a.questionId));
  const repeatedPatterns = getRepeatedMistakePatterns(questions.filter((q) => myMistakeQuestionIds.has(q.id) || chapterIds.includes(q.chapterId)));

  // WHAT WENT WELL / WHAT NEEDS WORK — completed tests only, from real data.
  const wentWell = [];
  const needsWork = [];
  if (test.status === "Completed") {
    if (test.accuracy != null && test.accuracy >= 75) wentWell.push(`Overall accuracy was ${test.accuracy}%`);
    chapterReadinessList.forEach((c) => { if (c.stats.qCount >= 5 && c.stats.qAccuracy >= 80) wentWell.push(`${c.chapter.name}: ${c.stats.qAccuracy}% accuracy`); });
    const completedRevisionsForTest = revisions.filter((r) => r.status === "COMPLETED" && myMistakeQuestionIds.has(r.targetId));
    if (completedRevisionsForTest.length > 0) wentWell.push(`${completedRevisionsForTest.length} revision(s) already completed from this test`);
    if (test.accuracy != null && test.accuracy < 60) needsWork.push(`Overall accuracy was only ${test.accuracy}%`);
    weakChapters.forEach((c) => needsWork.push(`${c.chapter.name} is a weak chapter`));
    repeatedPatterns.slice(0, 3).forEach((p) => needsWork.push(`Repeated ${p.mistakeType} mistakes in ${p.chapterName} (${p.count}x)`));
    if (chapterIds.length > 0) {
      const incompleteCount = chapterReadinessList.filter((c) => c.readiness < 60).length;
      if (incompleteCount > 0) needsWork.push(`${incompleteCount} chapter(s) in this syllabus still under 60% ready`);
    }
  }

  // Post-test suggestions — separate from the pre-test PREPARATION engine above.
  const postTestSuggestions = [];
  if (test.status === "Completed") {
    chapterPerformance.forEach((cp) => {
      if (cp.wrongCount >= 2) postTestSuggestions.push({ id: `${cp.chapter.id}-wrong`, chapter: cp.chapter, reason: `${cp.wrongCount} wrong questions in this test`, priority: cp.priority, type: "REVISION", estimatedMinutes: 30 });
    });
    weakChapters.forEach((c) => postTestSuggestions.push({ id: `${c.chapter.id}-weak`, chapter: c.chapter, reason: "Weak chapter", priority: "HIGH", type: "REVISION", estimatedMinutes: 30 }));
  }
  const visiblePostTestSuggestions = postTestSuggestions.filter((s) => !dismissed.has(s.id)).slice(0, 6);

  // Revisions and tasks that trace back to this test's own analysis records.
  const revisionsFromTest = revisions.filter((r) => r.targetType === "question" && myMistakeQuestionIds.has(r.targetId));
  const tasksFromAnalysis = myAnalysis.filter((a) => a.taskId).map((a) => ({ analysis: a, task: tasks.find((t) => t.id === a.taskId) })).filter((x) => x.task);

  // Preparation suggestions — generated only, never auto-created as tasks.
  const suggestions = [];
  chapterReadinessList.forEach(({ chapter, stats, checklist }) => {
    const checked = Object.fromEntries(checklist.items.map((i) => [i.key, i.checked]));
    if (!checked.lectures) suggestions.push({ id: `${chapter.id}-lec`, chapter, reason: "Lectures not complete", priority: "HIGH", type: "LECTURE", estimatedMinutes: 45 });
    if (stats.qCount < TEST_QUESTION_TARGET_PER_CHAPTER) suggestions.push({ id: `${chapter.id}-q`, chapter, reason: `Only ${stats.qCount}/${TEST_QUESTION_TARGET_PER_CHAPTER} questions practiced`, priority: "HIGH", type: "QUESTIONS", estimatedMinutes: 45 });
    if (stats.qCount >= 5 && stats.qAccuracy < 60) suggestions.push({ id: `${chapter.id}-acc`, chapter, reason: `Accuracy only ${stats.qAccuracy}%`, priority: "CRITICAL", type: "QUESTIONS", estimatedMinutes: 30 });
    if (stats.revisionsDueCount > 0) suggestions.push({ id: `${chapter.id}-rev`, chapter, reason: "Revision overdue", priority: "CRITICAL", type: "REVISION", estimatedMinutes: 30 });
    if (stats.mistakeCount > 0) suggestions.push({ id: `${chapter.id}-mis`, chapter, reason: `${stats.mistakeCount} open mistakes`, priority: "MEDIUM", type: "REVISION", estimatedMinutes: 20 });
  });
  const visibleSuggestions = suggestions.filter((s) => !dismissed.has(s.id)).slice(0, 8);

  function addSyllabusChapter() {
    if (!addChapterId) return;
    const chapter = CHAPTERS.find((c) => c.id === addChapterId);
    addTestSyllabusEntry({ testId, subjectId: addSubjectId, chapterId: addChapterId, topicId: addTopicId, section: sectionForChapter(chapter) });
    setAddChapterId(""); setAddTopicId("");
  }

  const addChapter = CHAPTERS.find((c) => c.id === addChapterId);
  const addChapterOptions = CHAPTERS.filter((c) => c.subjectId === addSubjectId);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <button onClick={onBack} className="text-xs text-slate-500 hover:text-slate-300 mb-4">← Back to tests</button>

      <div className="flex items-start justify-between mb-1 gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-slate-100">{test.testNumber ? `#${test.testNumber} · ` : ""}{test.name}</h1>
        <Badge tone={{ Upcoming: "medium", Completed: "done", Missed: "critical", Cancelled: "neutral" }[test.status]}>{test.status}</Badge>
      </div>
      <p className="text-sm text-slate-500 mb-6">{test.series} · {formatDate(test.date)} · max {test.maxScore}</p>

      {/* TEST ANALYSIS SUMMARY — completed tests only, real data only */}
      {test.status === "Completed" && (wentWell.length > 0 || needsWork.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          <Card className="p-4">
            <p className="text-xs font-semibold text-emerald-400 mb-2">WHAT WENT WELL</p>
            {wentWell.length === 0 ? <p className="text-xs text-slate-600">Nothing stood out yet.</p> : (
              <ul className="space-y-1">{wentWell.slice(0, 5).map((w, i) => <li key={i} className="text-xs text-slate-400">• {w}</li>)}</ul>
            )}
          </Card>
          <Card className="p-4">
            <p className="text-xs font-semibold text-rose-400 mb-2">WHAT NEEDS WORK</p>
            {needsWork.length === 0 ? <p className="text-xs text-slate-600">Nothing flagged yet.</p> : (
              <ul className="space-y-1">{needsWork.slice(0, 5).map((w, i) => <li key={i} className="text-xs text-slate-400">• {w}</li>)}</ul>
            )}
          </Card>
        </div>
      )}

      {/* OVERVIEW */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Days remaining" value={test.status === "Upcoming" ? daysRemaining : "—"} />
        <StatCard label="Syllabus size" value={`${chapterIds.length} chapters`} />
        <StatCard label="Overall readiness" value={overallReadiness === null ? "—" : `${overallReadiness}%`} />
        <StatCard label="Preparation mode" value={test.status === "Upcoming" ? prep.mode : "—"} />
      </div>

      {/* READINESS */}
      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-3">READINESS</p>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Physics" value={physicsReadiness === null ? "— no chapters" : `${physicsReadiness}%`} />
          <StatCard label="Chemistry" value={chemistryReadiness === null ? "— no chapters" : `${chemistryReadiness}%`} />
          <StatCard label="Biology" value={biologyReadiness === null ? "— no chapters" : `${biologyReadiness}%`} />
        </div>
      </Card>

      {/* PREPARATION */}
      {test.status === "Upcoming" && (
        <Card className="p-4 mb-6">
          <p className="text-xs font-semibold text-slate-300 mb-2">PREPARATION</p>
          <p className="text-sm text-slate-300 mb-1">{prep.mode} — {daysRemaining}d remaining</p>
          <p className="text-xs text-slate-500 mb-3">Recommended split: {prep.revisionPct}% revision · {prep.questionsPct}% questions (a guide, not a mandate)</p>
          {visibleSuggestions.length === 0 ? (
            <p className="text-xs text-slate-600">No deficiencies detected from stored data yet.</p>
          ) : (
            <div className="space-y-2">
              {visibleSuggestions.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm text-slate-300 truncate">{s.chapter.name}</p>
                    <p className="text-xs text-slate-600">{s.reason} · {s.priority} · ~{s.estimatedMinutes}m</p>
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <Button variant="ghost" onClick={() => setSuggestTask(s)} className="!py-1 !px-2 text-xs">Create task</Button>
                    <Button variant="ghost" onClick={() => setDismissed((prev) => new Set([...prev, s.id]))} className="!py-1 !px-2 text-xs">Dismiss</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* WEAK CHAPTERS */}
      {weakChapters.length > 0 && (
        <Card className="p-4 mb-6">
          <p className="text-xs font-semibold text-slate-300 mb-2">WEAK CHAPTERS</p>
          {weakChapters.map(({ chapter, readiness }) => (
            <button key={chapter.id} onClick={() => onOpenChapter(chapter.id)} className="w-full flex items-center justify-between py-1.5 text-left hover:text-indigo-400">
              <span className="text-sm text-slate-300">{chapter.name}</span>
              <span className="text-xs font-mono text-slate-500">{readiness}%</span>
            </button>
          ))}
        </Card>
      )}

      {/* SYLLABUS */}
      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-3">SYLLABUS</p>
        <div className="grid grid-cols-3 gap-2 mb-2">
          <select className={inputClass} value={addSubjectId} onChange={(e) => { setAddSubjectId(e.target.value); setAddChapterId(""); setAddTopicId(""); }}>
            {SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className={inputClass} value={addChapterId} onChange={(e) => { setAddChapterId(e.target.value); setAddTopicId(""); }}>
            <option value="">— Chapter —</option>
            {addChapterOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className={inputClass} value={addTopicId} onChange={(e) => setAddTopicId(e.target.value)} disabled={!addChapter}>
            <option value="">— Topic (optional) —</option>
            {addChapter?.topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <Button variant="ghost" onClick={addSyllabusChapter} disabled={!addChapterId} className="mb-3">+ Add chapter</Button>

        {TEST_SECTIONS.map((sec) => bySection[sec].length > 0 && (
          <div key={sec} className="mb-2">
            <p className="text-[11px] text-slate-600 mb-1">{sec.toUpperCase()}</p>
            {bySection[sec].map((s) => {
              const chapter = CHAPTERS.find((c) => c.id === s.chapterId);
              return (
                <div key={s.id} className="flex items-center justify-between py-1">
                  <button onClick={() => onOpenChapter(s.chapterId)} className="text-sm text-slate-300 hover:text-indigo-400 truncate">{chapter?.name}</button>
                  <button onClick={() => removeTestSyllabusEntry(s.id)} className="text-xs text-slate-600 hover:text-rose-400">Remove</button>
                </div>
              );
            })}
          </div>
        ))}
        {mySyllabus.length === 0 && <p className="text-sm text-slate-600">No chapters added yet.</p>}
      </Card>

      {/* QUESTIONS */}
      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-3">QUESTIONS</p>
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total" value={aggQCount} />
          <StatCard label="Accuracy" value={`${aggAccuracy}%`} />
          <StatCard label="Deficit" value={Math.max(0, chapterIds.length * TEST_QUESTION_TARGET_PER_CHAPTER - aggQCount)} sub={`target ${chapterIds.length * TEST_QUESTION_TARGET_PER_CHAPTER}`} />
        </div>
      </Card>

      {/* REVISIONS + MISTAKES */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        <Card className="p-4">
          <p className="text-xs font-semibold text-slate-300 mb-2">REVISIONS DUE</p>
          <p className="text-2xl font-mono text-slate-100">{aggRevisionsDue}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-semibold text-slate-300 mb-2">MISTAKES</p>
          <p className="text-2xl font-mono text-slate-100">{aggMistakes}</p>
        </Card>
      </div>

      {/* TASKS */}
      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-2">TASKS LINKED TO THIS SYLLABUS ({linkedTasks.length})</p>
        {linkedTasks.length === 0 ? <p className="text-sm text-slate-600">None yet.</p> : linkedTasks.slice(0, 8).map((t) => (
          <div key={t.id} className="flex items-center justify-between py-1 text-sm">
            <span className={`text-slate-300 truncate ${t.status === "COMPLETED" ? "line-through opacity-60" : ""}`}>{t.title}</span>
            <Badge tone={t.status === "COMPLETED" ? "done" : "neutral"}>{t.status}</Badge>
          </div>
        ))}
      </Card>

      {/* RESULT / HISTORY */}
      {test.status === "Completed" ? (
        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-slate-300">RESULT</p>
            {scoreTrend !== null && (
              <span className={`text-xs font-mono ${scoreTrend >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {scoreTrend >= 0 ? "▲" : "▼"} {Math.abs(scoreTrend)} vs {formatDate(priorTest.date)}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <StatCard label="Score" value={`${test.score ?? "—"}/${test.maxScore}`} />
            <StatCard label="Accuracy" value={`${test.accuracy ?? 0}%`} />
            <StatCard label="Correct/Wrong/Unattempted" value={`${test.correct}/${test.wrong}/${test.unattempted}`} />
          </div>
          <p className="text-[11px] text-slate-600 mb-1.5">Test-level subject score (entered manually) vs. question-level accuracy (from logged questions)</p>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <StatCard label="Physics" value={test.subjectScores.physics ?? "—"} sub={physicsAccuracy === null ? "no questions logged" : `${physicsAccuracy}% accuracy`} />
            <StatCard label="Chemistry" value={test.subjectScores.chemistry ?? "—"} sub={chemistryAccuracy === null ? "no questions logged" : `${chemistryAccuracy}% accuracy`} />
            <StatCard label="Biology" value={test.subjectScores.biology ?? "—"} sub={biologyAccuracy === null ? "no questions logged" : `${biologyAccuracy}% accuracy`} />
          </div>
          {completedTests.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] text-slate-600 mb-1">PREVIOUS TESTS</p>
              {completedTests.slice(0, 5).map((t) => (
                <div key={t.id} className="flex justify-between text-xs text-slate-500 py-0.5">
                  <span className="truncate">{t.name}</span>
                  <span className="font-mono">{t.score}/{t.maxScore} · {t.accuracy}%</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-slate-300">RESULT</p>
            <Button variant="ghost" onClick={() => setShowResult(true)} className="!py-1 !px-2 text-xs">Enter result</Button>
          </div>
          <p className="text-sm text-slate-600 mt-1">Not completed yet.</p>
        </Card>
      )}

      {/* CHAPTER PERFORMANCE — from this test's actual wrong questions */}
      {test.status === "Completed" && chapterPerformance.length > 0 && (
        <Card className="p-4 mb-6">
          <p className="text-xs font-semibold text-slate-300 mb-3">CHAPTER PERFORMANCE (wrong questions)</p>
          {chapterPerformance.map((cp) => (
            <div key={cp.chapter.id} className="flex items-center justify-between py-1.5 border-b border-slate-800/50 last:border-0">
              <button onClick={() => onOpenChapter(cp.chapter.id)} className="text-sm text-slate-300 hover:text-indigo-400 truncate">{cp.chapter.name}</button>
              <div className="flex items-center gap-3 text-xs text-slate-500 flex-shrink-0">
                <span>{cp.wrongCount} wrong</span>
                <span>{cp.mistakeCount} mistakes</span>
                <span>{cp.accuracy === null ? "no accuracy data" : `${cp.accuracy}% acc.`}</span>
                <Badge tone={cp.priority === "HIGH" ? "critical" : cp.priority === "MEDIUM" ? "high" : "neutral"}>{cp.priority}</Badge>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* REPEATED MISTAKE PATTERNS — real patterns only (2+ occurrences) */}
      {test.status === "Completed" && repeatedPatterns.length > 0 && (
        <Card className="p-4 mb-6">
          <p className="text-xs font-semibold text-slate-300 mb-3">REPEATED MISTAKE PATTERNS</p>
          {repeatedPatterns.slice(0, 6).map((p, i) => (
            <div key={i} className="flex justify-between text-sm text-slate-400 py-1">
              <span>{p.chapterName} — {p.mistakeType}</span>
              <span className="font-mono text-slate-500">{p.count}x</span>
            </div>
          ))}
        </Card>
      )}

      {/* POST-TEST SUGGESTIONS — generated only, never auto-created */}
      {test.status === "Completed" && visiblePostTestSuggestions.length > 0 && (
        <Card className="p-4 mb-6">
          <p className="text-xs font-semibold text-slate-300 mb-3">SUGGESTED NEXT STEPS</p>
          <div className="space-y-2">
            {visiblePostTestSuggestions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm text-slate-300 truncate">{s.chapter.name}</p>
                  <p className="text-xs text-slate-600">{s.reason} · {s.priority} · ~{s.estimatedMinutes}m</p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <Button variant="ghost" onClick={() => setSuggestTask(s)} className="!py-1 !px-2 text-xs">Create task</Button>
                  <Button variant="ghost" onClick={() => setDismissed((prev) => new Set([...prev, s.id]))} className="!py-1 !px-2 text-xs">Dismiss</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* TEST → REVISION / TASK LINKS */}
      {test.status === "Completed" && (revisionsFromTest.length > 0 || tasksFromAnalysis.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
          <Card className="p-4">
            <p className="text-xs font-semibold text-slate-300 mb-2">REVISIONS FROM THIS TEST ({revisionsFromTest.length})</p>
            {revisionsFromTest.length === 0 ? <p className="text-xs text-slate-600">None yet.</p> : revisionsFromTest.slice(0, 6).map((r) => (
              <div key={r.id} className="flex justify-between text-xs text-slate-500 py-0.5">
                <span>{r.revisionType} #{r.revisionNumber}</span>
                <Badge tone={r.status === "COMPLETED" ? "done" : "neutral"}>{r.status === "COMPLETED" ? "done" : formatDate(r.scheduledDate)}</Badge>
              </div>
            ))}
          </Card>
          <Card className="p-4">
            <p className="text-xs font-semibold text-slate-300 mb-2">TASKS FROM THIS TEST ({tasksFromAnalysis.length})</p>
            {tasksFromAnalysis.length === 0 ? <p className="text-xs text-slate-600">None yet.</p> : tasksFromAnalysis.slice(0, 6).map(({ task }) => (
              <div key={task.id} className="flex justify-between text-xs text-slate-500 py-0.5">
                <span className="truncate">{task.title}</span>
                <Badge tone={task.status === "COMPLETED" ? "done" : "neutral"}>{task.status}</Badge>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* TEST ANALYSIS — completed tests only */}
      {test.status === "Completed" && (
        <Card className="p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-300">TEST ANALYSIS ({myAnalysis.length})</p>
            <Button variant="ghost" onClick={() => setShowAnalysis(true)} className="!py-1 !px-2 text-xs">+ Add wrong question</Button>
          </div>
          {myAnalysis.length === 0 ? <p className="text-sm text-slate-600">No wrong-question analysis logged yet.</p> : myAnalysis.map((a) => {
            const q = questions.find((x) => x.id === a.questionId);
            if (!q) return null;
            return (
              <div key={a.id} className="py-2 border-b border-slate-800/50 last:border-0">
                <p className="text-sm text-slate-300 truncate">{q.questionText}</p>
                <p className="text-xs text-slate-600 mb-1.5">{a.mistakeType} · {a.correctApproach || "no correct-approach notes"}</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" onClick={() => setMistake(q.id, true, { mistakeType: a.mistakeType, mistakeNotes: a.notes, correctApproach: a.correctApproach })} className="!py-1 !px-2 text-xs">Save mistake</Button>
                  <Button variant="ghost" onClick={() => setImportant(q.id, true)} className="!py-1 !px-2 text-xs">Mark important</Button>
                  <Button variant="ghost" onClick={() => { setAnalysisTaskForId(a.id); setAnalysisTaskPrefill({ title: `Revise: ${q.questionText.slice(0, 40)}`, subjectId: q.subjectId, subject: SUBJECTS.find((s) => s.id === q.subjectId)?.name, chapterId: q.chapterId, type: "REVISION", priority: "HIGH", date: todayISO() }); }} className="!py-1 !px-2 text-xs">
                    {a.taskId ? "Task created ✓" : "Create revision task"}
                  </Button>
                  <Button variant="ghost" onClick={() => onOpenQuestion(q)} className="!py-1 !px-2 text-xs">Open question</Button>
                </div>
              </div>
            );
          })}
        </Card>
      )}

      <div className="flex gap-2 mb-10">
        <Button variant="danger" onClick={() => { deleteTest(testId); onBack(); }}>Delete test</Button>
      </div>

      <ResultEntryModal open={showResult} onClose={() => setShowResult(false)} test={test} onSave={(r) => setTestResult(testId, r)} />
      <TestAnalysisModal open={showAnalysis} onClose={() => setShowAnalysis(false)} testId={testId} chapterIds={chapterIds} onSave={createTestAnalysis} />
      <TaskModal open={!!suggestTask} onClose={() => setSuggestTask(null)}
        prefill={suggestTask ? { title: `${suggestTask.reason} — ${suggestTask.chapter.name}`, subjectId: suggestTask.chapter.subjectId, subject: SUBJECTS.find((s) => s.id === suggestTask.chapter.subjectId)?.name, chapterId: suggestTask.chapter.id, type: suggestTask.type, priority: suggestTask.priority, estimatedMinutes: suggestTask.estimatedMinutes } : null}
        onSave={createTask} />
      <TaskModal open={!!analysisTaskPrefill} onClose={() => { setAnalysisTaskPrefill(null); setAnalysisTaskForId(null); }}
        prefill={analysisTaskPrefill}
        onSave={(f) => { const t = createTask(f); if (t && analysisTaskForId) linkTestAnalysisTask(analysisTaskForId, t.id); }} />
    </div>
  );
}

function ResultEntryModal({ open, onClose, test, onSave }) {
  const [form, setForm] = useState({ correct: 0, wrong: 0, unattempted: 0, score: "", subjectScores: { physics: "", chemistry: "", biology: "" } });
  useEffect(() => { if (open) setForm({ correct: test.correct ?? 0, wrong: test.wrong ?? 0, unattempted: test.unattempted ?? 0, score: test.score ?? "", subjectScores: { physics: test.subjectScores?.physics ?? "", chemistry: test.subjectScores?.chemistry ?? "", biology: test.subjectScores?.biology ?? "" } }); }, [open, test]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function setSubjectScore(k, v) { setForm((f) => ({ ...f, subjectScores: { ...f.subjectScores, [k]: v } })); }

  return (
    <Modal open={open} onClose={onClose} title="Enter test result">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Correct"><input type="number" min={0} className={inputClass} value={form.correct} onChange={(e) => set("correct", Math.max(0, safeNumber(e.target.value, 0)))} /></Field>
        <Field label="Wrong"><input type="number" min={0} className={inputClass} value={form.wrong} onChange={(e) => set("wrong", Math.max(0, safeNumber(e.target.value, 0)))} /></Field>
        <Field label="Unattempted"><input type="number" min={0} className={inputClass} value={form.unattempted} onChange={(e) => set("unattempted", Math.max(0, safeNumber(e.target.value, 0)))} /></Field>
      </div>
      <Field label="Score (defaults to correct×4 − wrong if left blank)">
        <input type="number" className={inputClass} value={form.score} onChange={(e) => set("score", e.target.value)} placeholder={String(form.correct * 4 - form.wrong)} />
      </Field>
      <p className="text-xs text-slate-600 mb-3">Total questions represented: <span className="font-mono text-slate-400">{form.correct + form.wrong + form.unattempted}</span>{form.correct + form.wrong + form.unattempted === 0 && " — nothing entered yet"}</p>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Physics score"><input className={inputClass} value={form.subjectScores.physics} onChange={(e) => setSubjectScore("physics", e.target.value)} /></Field>
        <Field label="Chemistry score"><input className={inputClass} value={form.subjectScores.chemistry} onChange={(e) => setSubjectScore("chemistry", e.target.value)} /></Field>
        <Field label="Biology score"><input className={inputClass} value={form.subjectScores.biology} onChange={(e) => setSubjectScore("biology", e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { onSave(form); onClose(); }}>Save result</Button>
      </div>
    </Modal>
  );
}

function TestAnalysisModal({ open, onClose, testId, chapterIds, onSave }) {
  const { questions, createQuestion } = useAppData();
  const [questionId, setQuestionId] = useState("");
  const [newQuestionText, setNewQuestionText] = useState("");
  const [mistakeType, setMistakeType] = useState("Conceptual");
  const [correctApproach, setCorrectApproach] = useState("");
  const [notes, setNotes] = useState("");
  const [chapterId, setChapterId] = useState(chapterIds[0] || "");

  useEffect(() => { if (open) { setQuestionId(""); setNewQuestionText(""); setMistakeType("Conceptual"); setCorrectApproach(""); setNotes(""); setChapterId(chapterIds[0] || ""); } }, [open, chapterIds]);

  const candidateQuestions = questions.filter((q) => chapterIds.includes(q.chapterId));

  function submit() {
    let qId = questionId;
    const chapter = CHAPTERS.find((c) => c.id === chapterId);
    if (!qId) {
      if (!newQuestionText.trim() || !chapter) return;
      const q = createQuestion({ questionText: newQuestionText, subjectId: chapter.subjectId, chapterId, source: "Test", isCorrect: false });
      if (!q) return;
      qId = q.id;
    }
    const q = questions.find((x) => x.id === qId) || { chapterId, subjectId: chapter?.subjectId };
    onSave({ testId, questionId: qId, chapterId: q.chapterId, mistakeType, correctApproach, notes });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Add wrong-question analysis">
      <Field label="Existing question from this test's syllabus (optional)">
        <select className={inputClass} value={questionId} onChange={(e) => setQuestionId(e.target.value)}>
          <option value="">— Create a new question instead —</option>
          {candidateQuestions.map((q) => <option key={q.id} value={q.id}>{q.questionText.slice(0, 60)}</option>)}
        </select>
      </Field>
      {!questionId && (
        <>
          <Field label="New question text">
            <textarea className={inputClass} rows={2} value={newQuestionText} onChange={(e) => setNewQuestionText(e.target.value)} />
          </Field>
          <Field label="Chapter">
            <select className={inputClass} value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
              {chapterIds.map((id) => <option key={id} value={id}>{CHAPTERS.find((c) => c.id === id)?.name}</option>)}
            </select>
          </Field>
        </>
      )}
      <Field label="Mistake type">
        <select className={inputClass} value={mistakeType} onChange={(e) => setMistakeType(e.target.value)}>
          {MISTAKE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Correct approach">
        <textarea className={inputClass} rows={2} value={correctApproach} onChange={(e) => setCorrectApproach(e.target.value)} />
      </Field>
      <Field label="Notes">
        <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit}>Save</Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------
   HEATMAP + DAILY STUDY GRAPH — both read straight from the same
   getDailyMinutesMap(sessions) used by computeStreaks, so the
   heatmap, the graph, and the streak numbers can never disagree.
   ------------------------------------------------------------ */

function DailyStudyGraph({ dailyMinutesMap }) {
  const [range, setRange] = useState(30);
  const days = Array.from({ length: range }, (_, i) => dateToISO(addDays(new Date(), -(range - 1 - i))));
  const values = days.map((d) => dailyMinutesMap[d] || 0);
  const max = Math.max(1, ...values);

  return (
    <Card className="p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-300">DAILY FOCUSED TIME</p>
        <FilterPills value={range} onChange={setRange} options={[{ id: 7, label: "7d" }, { id: 30, label: "30d" }, { id: 90, label: "90d" }]} />
      </div>
      <div className="flex items-end gap-0.5 h-24">
        {values.map((v, i) => (
          <div key={i} className="flex-1 group relative">
            <div className="w-full bg-indigo-400/80 hover:bg-indigo-300 rounded-t-sm" style={{ height: `${Math.max(2, (v / max) * 96)}px` }} />
            <div className="hidden group-hover:block absolute bottom-full left-1/2 -translate-x-1/2 mb-1 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] text-slate-300 whitespace-nowrap z-10">
              {formatDate(days[i])} · {minutesToLabel(v)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function StudyHeatmap({ sessions, dailyMinutesMap }) {
  const [selected, setSelected] = useState(null);
  const start = new Date(PREP_START_DATE + "T00:00:00");
  const gridStart = startOfWeek(start);
  const today = new Date();
  const totalDays = Math.floor((today - gridStart) / 86400000) + 1;
  const weeks = Math.ceil(totalDays / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));

  const toneForBucket = ["bg-slate-800", "bg-indigo-950", "bg-indigo-800", "bg-indigo-600", "bg-indigo-400"];

  function openDay(dateObj) {
    const iso = dateToISO(dateObj);
    const daySessions = sessions.filter((s) => s.date === iso);
    setSelected({ date: iso, minutes: dailyMinutesMap[iso] || 0, sessions: daySessions.length });
  }

  return (
    <Card className="p-4 mb-6">
      <p className="text-xs font-semibold text-slate-300 mb-3">STUDY HEATMAP — since {formatDate(PREP_START_DATE)}</p>
      <div className="overflow-x-auto">
        <div className="grid grid-flow-col grid-rows-7 gap-1 w-max">
          {cells.map((d, i) => {
            const iso = dateToISO(d);
            const beforeStart = iso < PREP_START_DATE;
            const afterToday = iso > todayISO();
            const minutes = dailyMinutesMap[iso] || 0;
            const bucket = getHeatmapBucket(minutes);
            return (
              <button
                key={i}
                disabled={beforeStart || afterToday}
                onClick={() => openDay(d)}
                title={`${formatDate(iso)} — ${minutesToLabel(minutes)}`}
                className={`w-3 h-3 rounded-sm ${beforeStart || afterToday ? "bg-transparent" : toneForBucket[bucket]}`}
              />
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-1 mt-2 text-[10px] text-slate-600">
        <span>Less</span>
        {toneForBucket.map((t, i) => <span key={i} className={`w-3 h-3 rounded-sm ${t}`} />)}
        <span>More</span>
      </div>
      {selected && (
        <Modal open onClose={() => setSelected(null)} title={formatDate(selected.date)}>
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Focused" value={minutesToLabel(selected.minutes)} />
            <StatCard label="Sessions" value={selected.sessions} />
          </div>
        </Modal>
      )}
    </Card>
  );
}

function AnalyticsSubjectCard({ subject, data }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-slate-200 mb-2">{subject.name.toUpperCase()}</p>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-slate-600">Focused</span><p className="font-mono text-slate-300">{minutesToLabel(data.focusedMinutes)}</p></div>
        <div><span className="text-slate-600">Sessions</span><p className="font-mono text-slate-300">{data.sessionsCount}</p></div>
        <div><span className="text-slate-600">Questions</span><p className="font-mono text-slate-300">{data.questionsCount}</p></div>
        <div><span className="text-slate-600">Accuracy</span><p className="font-mono text-slate-300">{data.accuracy}%</p></div>
        <div><span className="text-slate-600">Chapters studied</span><p className="font-mono text-slate-300">{data.chaptersStudied}/{data.totalChapters}</p></div>
      </div>
    </Card>
  );
}

function AnalyticsPage({ onOpenChapter, onOpenTest }) {
  const { tasks, sessions, lectures, resources, questions, revisions, tests, settings, chapterProgress } = useAppData();
  const dailyMinutesMap = getDailyMinutesMap(sessions);
  const overview = getOverviewStats(tasks, sessions, questions, tests);

  const today = todayISO();
  const now = new Date();
  const weekStart = dateToISO(startOfWeek(now));
  const monthStart = dateToISO(startOfMonth(now));
  const todayStats = getRangeStats(today, today, tasks, sessions, questions, tests);
  const weekStats = getRangeStats(weekStart, today, tasks, sessions, questions, tests);
  const monthStats = getRangeStats(monthStart, today, tasks, sessions, questions, tests);

  const subjectData = SUBJECTS.map((s) => ({ subject: s, data: getSubjectAnalytics(s.id, tasks, sessions, questions, revisions, lectures, resources) }));
  const activeChapters = getActiveChapterAnalytics(tasks, sessions, lectures, resources, questions, revisions, chapterProgress);
  const mistakeDist = getMistakeTypeDistribution(questions);
  const testSummary = getTestAnalyticsSummary(tests);

  const qCorrect = questions.filter((q) => q.isCorrect === true).length;
  const qIncorrect = questions.filter((q) => q.isCorrect === false).length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-semibold text-slate-100 mb-6">Analytics</h1>

      {settings.prepBaseline?.completedPercent != null && (
        <Card className="p-4 mb-4">
          <p className="text-xs font-semibold text-slate-300 mb-1">HISTORICAL / INITIAL STATE</p>
          <p className="text-sm text-slate-400">
            Overall baseline: <span className="font-mono text-indigo-400">{settings.prepBaseline.completedPercent}%</span> complete
            (does not affect today/week/streak/heatmap metrics below).
          </p>
        </Card>
      )}

      {/* OVERVIEW */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total focused time" value={minutesToLabel(overview.focusedMinutes)} />
        <StatCard label="Total sessions" value={overview.sessionsCount} />
        <StatCard label="Total questions" value={overview.questionsCount} />
        <StatCard label="Overall accuracy" value={`${overview.accuracy}%`} />
        <StatCard label="Tests completed" value={overview.testsCompleted} />
        <StatCard label="Avg test score" value={overview.avgScore ?? "—"} />
        <StatCard label="Current streak" value={`${overview.currentStreak}d`} />
        <StatCard label="Longest streak" value={`${overview.longestStreak}d`} />
      </div>

      <DailyStudyGraph dailyMinutesMap={dailyMinutesMap} />
      <StudyHeatmap sessions={sessions} dailyMinutesMap={dailyMinutesMap} />

      {/* TODAY / WEEK / MONTH */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {[["Today", todayStats], ["This week", weekStats], ["This month", monthStats]].map(([label, s]) => (
          <Card key={label} className="p-4">
            <p className="text-xs font-semibold text-slate-300 mb-2">{label.toUpperCase()}</p>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-slate-600">Focused</span><span className="font-mono text-slate-300">{minutesToLabel(s.focusedMinutes)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Sessions</span><span className="font-mono text-slate-300">{s.sessionsCount}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Questions</span><span className="font-mono text-slate-300">{s.questionsCount}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Accuracy</span><span className="font-mono text-slate-300">{s.accuracy}%</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Tasks done</span><span className="font-mono text-slate-300">{s.tasksCompleted}/{s.tasksTotal}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Tests</span><span className="font-mono text-slate-300">{s.testsCompleted}</span></div>
            </div>
          </Card>
        ))}
      </div>

      {/* SUBJECTS */}
      <p className="text-xs text-slate-500 font-medium tracking-wide mb-2">SUBJECTS</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {subjectData.map(({ subject, data }) => <AnalyticsSubjectCard key={subject.id} subject={subject} data={data} />)}
      </div>

      {/* QUESTIONS */}
      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-3">QUESTIONS</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <StatCard label="Total" value={questions.length} />
          <StatCard label="Correct" value={qCorrect} />
          <StatCard label="Incorrect" value={qIncorrect} />
          <StatCard label="Accuracy" value={`${Math.round(safeDiv(qCorrect, qCorrect + qIncorrect) * 100)}%`} />
        </div>
        {mistakeDist.length > 0 && (
          <div>
            <p className="text-[11px] text-slate-600 mb-1">MISTAKE TYPE DISTRIBUTION</p>
            {mistakeDist.map(([type, count]) => (
              <div key={type} className="flex justify-between text-xs text-slate-400 py-0.5"><span>{type}</span><span className="font-mono">{count}</span></div>
            ))}
          </div>
        )}
      </Card>

      {/* TESTS */}
      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-3">TESTS</p>
        {!testSummary ? (
          <p className="text-sm text-slate-600">No completed tests yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-2">
              <StatCard label="Completed" value={testSummary.count} />
              <StatCard label="Avg score" value={testSummary.avgScore} />
              <StatCard label="Best" value={testSummary.bestScore} />
              <StatCard label="Lowest" value={testSummary.lowestScore} />
            </div>
            {testSummary.trend.length === 0 ? (
              <p className="text-xs text-slate-600">Score trend needs at least 2 completed tests.</p>
            ) : (
              <div className="flex items-end gap-1 h-16 mt-3">
                {testSummary.trend.map((t, i) => {
                  const max = Math.max(...testSummary.trend.map((x) => x.score), 1);
                  return (
                    <button key={i} onClick={() => onOpenTest && onOpenTest(tests.find((x) => x.date === t.date && x.name === t.name)?.id)}
                      className="flex-1 bg-indigo-500/70 hover:bg-indigo-400 rounded-t-sm" style={{ height: `${Math.max(4, (t.score / max) * 64)}px` }} title={`${t.name}: ${t.score}`} />
                  );
                })}
              </div>
            )}
          </>
        )}
      </Card>

      {/* CHAPTERS */}
      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-3">CHAPTERS WITH ACTIVITY ({activeChapters.length})</p>
        {activeChapters.length === 0 ? (
          <p className="text-sm text-slate-600">No chapter activity logged yet.</p>
        ) : (
          activeChapters.slice(0, 15).map(({ chapter, stats }) => (
            <button key={chapter.id} onClick={() => onOpenChapter(chapter.id)} className="w-full flex items-center justify-between py-1.5 border-b border-slate-800/50 last:border-0 text-left hover:bg-slate-800/30 px-1">
              <span className="text-sm text-slate-300 truncate">{chapter.name}</span>
              <span className="text-xs text-slate-500 font-mono flex-shrink-0">
                {minutesToLabel(stats.studyMinutes)} · Q{stats.qCount} · {stats.qAccuracy}% · {stats.importantCount}★ · {stats.mistakeCount}✕
              </span>
            </button>
          ))
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------
   BACKLOG PAGE
   ------------------------------------------------------------ */

function BacklogRow({ task, onComplete, onEdit, onCancel, onReschedule }) {
  const priorityTone = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" }[task.priority];
  const chapter = CHAPTERS.find((c) => c.id === task.chapterId);
  const [rescheduling, setRescheduling] = useState(false);
  const daysOverdue = localDaysBetween(task.date, todayISO());

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/60 last:border-0 flex-wrap">
      <button
        onClick={() => onComplete(task.id)}
        className="w-5 h-5 rounded-md border border-slate-600 hover:border-indigo-400 flex-shrink-0"
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-200 truncate">{task.title}</p>
        <p className="text-xs text-slate-500 mt-0.5">
          {[task.subject, chapter?.name, task.type].filter(Boolean).join(" · ") || "General"}
          {" · "}{minutesToLabel(task.estimatedMinutes)} · due {formatDate(task.date)}
        </p>
      </div>
      <Badge tone="critical">{daysOverdue}d overdue</Badge>
      <Badge tone={priorityTone}>{task.priority}</Badge>
      {rescheduling ? (
        <input type="date" autoFocus defaultValue={todayISO()}
          onBlur={(e) => { onReschedule(task.id, e.target.value); setRescheduling(false); }}
          onChange={(e) => { onReschedule(task.id, e.target.value); setRescheduling(false); }}
          className="bg-[#131316] border border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-200" />
      ) : (
        <button onClick={() => setRescheduling(true)} className="text-slate-600 hover:text-slate-300 text-xs px-2">Reschedule</button>
      )}
      <button onClick={() => onEdit(task)} className="text-slate-600 hover:text-slate-300 text-xs px-2">Edit</button>
      <button onClick={() => onCancel(task.id)} className="text-slate-600 hover:text-rose-400 text-xs px-2">Cancel</button>
    </div>
  );
}

const BACKLOG_BUCKET_LABELS = [
  { key: "day1", label: "New (1d)" },
  { key: "days1to3", label: "1–3 days" },
  { key: "days4to7", label: "4–7 days" },
  { key: "days8plus", label: "8+ days" },
];

function BacklogPage() {
  const { tasks, completeTask, updateTask, createTask, rescheduleTask } = useAppData();
  const [editing, setEditing] = useState(null);

  const backlogTasks = getBacklogTasks(tasks);
  const stats = getBacklogStats(tasks);
  const ranked = rankBacklogTasks(backlogTasks, todayISO());

  function cancelTask(id) { updateTask(id, { status: "CANCELLED" }); }
  function reschedule(id, date) { rescheduleTask(id, date); }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold text-slate-100 mb-1">Backlog</h1>
      <p className="text-xs text-slate-600 mb-6">Past-due tasks stay on their original date until you explicitly reschedule them — nothing here moves automatically.</p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <StatCard label="Current backlog" value={stats.count} />
        {BACKLOG_BUCKET_LABELS.map((b) => (
          <StatCard key={b.key} label={b.label} value={stats.buckets[b.key]} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard label="Completed from backlog" value={stats.completedFromBacklog} />
        <StatCard label="Oldest backlog item" value={stats.oldest ? formatDate(stats.oldest.date) : "—"} sub={stats.oldest?.title} />
      </div>

      {ranked.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-600">No backlog — nothing overdue right now.</Card>
      ) : (
        <Card>
          {ranked.map((t) => (
            <BacklogRow key={t.id} task={t} onComplete={completeTask} onEdit={setEditing} onCancel={cancelTask} onReschedule={reschedule} />
          ))}
        </Card>
      )}

      <TaskModal open={!!editing} initial={editing} onClose={() => setEditing(null)} onSave={(f) => updateTask(f.id, f)} />
    </div>
  );
}


/* ------------------------------------------------------------
   WEEKLY REVIEW — live records only (no historical inflation)
   ------------------------------------------------------------ */

function weekRangeForOffset(offsetWeeks = 0) {
  const now = new Date();
  const start = startOfWeek(addDays(now, offsetWeeks * 7));
  const end = addDays(start, 6);
  return { start: dateToISO(start), end: dateToISO(end), startDate: start };
}

function deltaLabel(cur, prev, unit = "") {
  if (prev === 0 && cur === 0) return "—";
  if (prev === 0) return cur > 0 ? `+${cur}${unit} (new)` : "—";
  const d = cur - prev;
  const sign = d > 0 ? "+" : "";
  return `${sign}${d}${unit}`;
}

function WeeklyReviewPage({ onOpenChapter, onOpenTest }) {
  const { tasks, sessions, questions, tests, revisions, chapterProgress, weeklyReviews, setWeeklyReview, testSyllabus } = useAppData();
  const [weekOffset, setWeekOffset] = useState(0);
  const range = weekRangeForOffset(weekOffset);
  const prevRange = weekRangeForOffset(weekOffset - 1);

  const stats = getRangeStats(range.start, range.end, tasks, sessions, questions, tests);
  const prevStats = getRangeStats(prevRange.start, prevRange.end, tasks, sessions, questions, tests);

  const weekRevisionsCompleted = revisions.filter((r) => r.status === "COMPLETED" && r.completedDate >= range.start && r.completedDate <= range.end).length;
  const prevWeekRevisions = revisions.filter((r) => r.status === "COMPLETED" && r.completedDate >= prevRange.start && r.completedDate <= prevRange.end).length;

  // Backlog created this week: tasks whose date is before week start but completed/cancelled in week, OR tasks that became overdue during the week.
  // Practical definition: tasks currently in backlog that were scheduled in this week OR before, counted as "created" when their date falls in week or they sit overdue.
  const weekTasks = tasks.filter((t) => t.date >= range.start && t.date <= range.end);
  const backlogCreated = weekTasks.filter((t) => isBacklogTask(t, todayISO()) || (t.status === "COMPLETED" && t.completedAt && dateToISO(new Date(t.completedAt)) > t.date)).length;
  const backlogCleared = tasks.filter((t) => {
    if (t.status !== "COMPLETED" || !t.completedAt) return false;
    const cd = dateToISO(new Date(t.completedAt));
    return cd >= range.start && cd <= range.end && cd > t.date;
  }).length;

  const weekTests = tests.filter((t) => t.date >= range.start && t.date <= range.end);
  const completedWeekTests = weekTests.filter((t) => t.status === "Completed");

  const subjectBreakdown = SUBJECTS.map((s) => {
    const ids = new Set(CHAPTERS.filter((c) => c.subjectId === s.id).map((c) => c.id));
    const subSessions = sessions.filter((x) => x.date >= range.start && x.date <= range.end && ids.has(x.chapterId));
    const mins = subSessions.reduce((a, x) => a + safeNumber(x.durationMinutes, 0), 0);
    const subQ = questions.filter((q) => q.dateAdded >= range.start && q.dateAdded <= range.end && q.subjectId === s.id);
    const correct = subQ.filter((q) => q.isCorrect === true).length;
    const incorrect = subQ.filter((q) => q.isCorrect === false).length;
    return {
      subject: s,
      focusedMinutes: mins,
      questions: subQ.length,
      accuracy: Math.round(safeDiv(correct, correct + incorrect) * 100),
      sessions: subSessions.length,
    };
  });

  // Weak / neglected — real data only
  const weakChapters = CHAPTERS.map((c) => {
    const st = getChapterStats(c.id, tasks, sessions, [], [], questions, revisions, chapterProgress);
    const checklist = getChapterChecklist(st, chapterProgress[c.id] || {});
    const status = getChapterStatus(st, checklist);
    return { chapter: c, stats: st, status, checklist };
  }).filter(({ stats, status }) => status === "WEAK" || (stats.qCount >= 5 && stats.qAccuracy < 60) || stats.mistakeCount >= 3 || stats.revisionsDueCount > 0);

  const upcomingTests = tests.filter((t) => t.status === "Upcoming" && t.date >= todayISO()).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const neglectedForTests = [];
  upcomingTests.forEach((t) => {
    const chIds = testSyllabus.filter((s) => s.testId === t.id).map((s) => s.chapterId);
    chIds.forEach((id) => {
      const chapterSessions = sessions.filter((s) => s.chapterId === id && s.date >= dateToISO(addDays(new Date(), -14)));
      if (chapterSessions.length === 0) {
        const ch = CHAPTERS.find((c) => c.id === id);
        if (ch && !neglectedForTests.some((x) => x.id === id)) neglectedForTests.push(ch);
      }
    });
  });

  const review = weeklyReviews[range.start] || { wentWell: "", wentWrong: "", focusNext: "" };
  const [wentWell, setWentWell] = useState(review.wentWell || "");
  const [wentWrong, setWentWrong] = useState(review.wentWrong || "");
  const [focusNext, setFocusNext] = useState(review.focusNext || "");
  useEffect(() => {
    const r = weeklyReviews[range.start] || {};
    setWentWell(r.wentWell || "");
    setWentWrong(r.wentWrong || "");
    setFocusNext(r.focusNext || "");
  }, [range.start, weeklyReviews]);

  // Next-week priorities (recommendations only)
  const priorities = [];
  upcomingTests.forEach((t) => priorities.push({ type: "Test", label: `${t.name} (${formatDate(t.date)})`, reason: "Upcoming test" }));
  revisions.filter((r) => r.status === "SCHEDULED" && r.scheduledDate <= todayISO()).slice(0, 5).forEach((r) => {
    const ch = CHAPTERS.find((c) => c.id === r.targetId);
    priorities.push({ type: "Revision", label: ch?.name || r.revisionType, reason: "Overdue revision" });
  });
  weakChapters.slice(0, 5).forEach(({ chapter, status }) => priorities.push({ type: "Chapter", label: chapter.name, reason: status === "WEAK" ? "Weak chapter" : "Needs attention" }));
  const importantDue = questions.filter((q) => q.isImportant && q.importantNextRevision && q.importantNextRevision <= todayISO()).length;
  if (importantDue > 0) priorities.push({ type: "Important", label: `${importantDue} important question(s) due`, reason: "Important revision due" });
  const openMistakes = questions.filter((q) => q.isMistake).length;
  if (openMistakes > 0) priorities.push({ type: "Mistakes", label: `${openMistakes} logged mistake(s)`, reason: "Review mistake book" });
  const backlogCount = getBacklogTasks(tasks).length;
  if (backlogCount > 0) priorities.push({ type: "Backlog", label: `${backlogCount} overdue tasks`, reason: "Clear backlog" });

  const isCurrent = weekOffset === 0;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-2">
        <div>
          <p className="text-xs text-slate-500 font-medium tracking-wide">WEEKLY REVIEW</p>
          <h1 className="text-xl font-semibold text-slate-100 mt-1">
            {formatDate(range.start)} – {formatDate(range.end)}
            {isCurrent && <span className="text-xs text-indigo-400 ml-2">Current week</span>}
          </h1>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setWeekOffset((o) => o - 1)}>← Previous</Button>
          <Button variant="ghost" onClick={() => setWeekOffset(0)} disabled={isCurrent}>Current</Button>
          <Button variant="ghost" onClick={() => setWeekOffset((o) => o + 1)} disabled={weekOffset >= 0}>Next →</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label="Focused time" value={minutesToLabel(stats.focusedMinutes)} sub={deltaLabel(stats.focusedMinutes, prevStats.focusedMinutes, "m") + " vs prev"} />
        <StatCard label="Sessions" value={stats.sessionsCount} sub={deltaLabel(stats.sessionsCount, prevStats.sessionsCount)} />
        <StatCard label="Questions" value={stats.questionsCount} sub={deltaLabel(stats.questionsCount, prevStats.questionsCount)} />
        <StatCard label="Accuracy" value={`${stats.accuracy}%`} sub={prevStats.questionsCount + prevStats.correct + prevStats.incorrect > 0 ? deltaLabel(stats.accuracy, prevStats.accuracy, "%") : "—"} />
        <StatCard label="Tasks planned" value={stats.tasksTotal} />
        <StatCard label="Tasks completed" value={stats.tasksCompleted} sub={deltaLabel(stats.tasksCompleted, prevStats.tasksCompleted)} />
        <StatCard label="Tests" value={weekTests.length} sub={`${completedWeekTests.length} completed`} />
        <StatCard label="Revisions done" value={weekRevisionsCompleted} sub={deltaLabel(weekRevisionsCompleted, prevWeekRevisions)} />
        <StatCard label="Backlog created" value={backlogCreated} />
        <StatCard label="Backlog cleared" value={backlogCleared} />
      </div>

      {completedWeekTests.length > 0 && (
        <Card className="p-4 mb-6">
          <p className="text-xs font-semibold text-slate-300 mb-2">TEST SCORES THIS WEEK</p>
          {completedWeekTests.map((t) => (
            <button key={t.id} onClick={() => onOpenTest && onOpenTest(t.id)} className="w-full flex justify-between text-sm py-1 text-left hover:text-indigo-400">
              <span className="text-slate-300 truncate">{t.name}</span>
              <span className="font-mono text-slate-400">{t.score ?? "—"}/{t.maxScore}</span>
            </button>
          ))}
        </Card>
      )}

      <p className="text-xs text-slate-500 font-medium tracking-wide mb-2">SUBJECT BREAKDOWN</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        {subjectBreakdown.map(({ subject, focusedMinutes, questions: qn, accuracy, sessions: sc }) => (
          <Card key={subject.id} className="p-4">
            <p className="text-sm font-semibold text-slate-200 mb-2">{subject.name}</p>
            <div className="text-xs space-y-1">
              <div className="flex justify-between"><span className="text-slate-600">Focused</span><span className="font-mono text-slate-300">{minutesToLabel(focusedMinutes)}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Sessions</span><span className="font-mono text-slate-300">{sc}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Questions</span><span className="font-mono text-slate-300">{qn}</span></div>
              <div className="flex justify-between"><span className="text-slate-600">Accuracy</span><span className="font-mono text-slate-300">{qn ? `${accuracy}%` : "—"}</span></div>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-2">WEAK / NEGLECTED CHAPTERS</p>
        {weakChapters.length === 0 && neglectedForTests.length === 0 ? (
          <p className="text-sm text-slate-600">None flagged from stored data this week.</p>
        ) : (
          <div className="space-y-1">
            {weakChapters.slice(0, 8).map(({ chapter, status, stats: st }) => (
              <button key={chapter.id} onClick={() => onOpenChapter && onOpenChapter(chapter.id)} className="w-full flex justify-between text-sm py-1 text-left hover:text-indigo-400">
                <span className="text-slate-300 truncate">{chapter.name}</span>
                <span className="text-xs text-slate-500">{STATUS_LABEL[status]} · Q{st.qCount} · {st.qAccuracy}%</span>
              </button>
            ))}
            {neglectedForTests.slice(0, 5).map((ch) => (
              <button key={"n" + ch.id} onClick={() => onOpenChapter && onOpenChapter(ch.id)} className="w-full flex justify-between text-sm py-1 text-left hover:text-indigo-400">
                <span className="text-slate-300 truncate">{ch.name}</span>
                <span className="text-xs text-amber-500">No study in 14d · upcoming test</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-3">WEEKLY REFLECTION</p>
        <Field label="What went well?">
          <textarea className={inputClass} rows={2} value={wentWell} onChange={(e) => setWentWell(e.target.value)} />
        </Field>
        <Field label="What went wrong?">
          <textarea className={inputClass} rows={2} value={wentWrong} onChange={(e) => setWentWrong(e.target.value)} />
        </Field>
        <Field label="What should I focus on next week?">
          <textarea className={inputClass} rows={2} value={focusNext} onChange={(e) => setFocusNext(e.target.value)} />
        </Field>
        <Button onClick={() => setWeeklyReview(range.start, { wentWell, wentWrong, focusNext })}>Save reflection</Button>
      </Card>

      <Card className="p-4 mb-6">
        <p className="text-xs font-semibold text-slate-300 mb-2">NEXT WEEK PRIORITIES</p>
        <p className="text-[11px] text-slate-600 mb-2">Recommendations only — tasks are not auto-created.</p>
        {priorities.length === 0 ? (
          <p className="text-sm text-slate-600">No priorities derived from stored data.</p>
        ) : (
          priorities.slice(0, 10).map((p, i) => (
            <div key={i} className="flex items-center gap-2 py-1 text-sm">
              <Badge>{p.type}</Badge>
              <span className="text-slate-300 truncate">{p.label}</span>
              <span className="text-xs text-slate-600 ml-auto">{p.reason}</span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}


/* ------------------------------------------------------------
   SHELL
   ------------------------------------------------------------ */


/* Surfaces render errors instead of a blank root (no feature change). */
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("NEET Prep OS render error:", error, info);
  }
  render() {
    if (this.state.error) {
      const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
      return (
        <div style={{ minHeight: "100vh", background: "#0a0a0c", color: "#e2e8f0", padding: 24, fontFamily: "system-ui,sans-serif" }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>Something went wrong</h1>
          <p style={{ color: "#94a3b8", fontSize: 14, marginBottom: 12 }}>The app hit a render error. Reload the page. If it keeps happening, clear site data for this origin.</p>
          <pre style={{ background: "#16161a", border: "1px solid #27272a", borderRadius: 8, padding: 12, fontSize: 12, overflow: "auto", color: "#fca5a5" }}>{msg}</pre>
          <button type="button" onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, background: "#6366f1", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const [route, setRoute] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedChapterId, setSelectedChapterId] = useState(null);
  const [openQuestionId, setOpenQuestionId] = useState(null);
  const [selectedTestId, setSelectedTestId] = useState(null);

  return (
    <AppErrorBoundary>
      <AppDataProvider>
        <ShellInner
          route={route} setRoute={setRoute}
          sidebarOpen={sidebarOpen} setSidebarOpen={setSidebarOpen}
          sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed}
          selectedChapterId={selectedChapterId} setSelectedChapterId={setSelectedChapterId}
          openQuestionId={openQuestionId} setOpenQuestionId={setOpenQuestionId}
          selectedTestId={selectedTestId} setSelectedTestId={setSelectedTestId}
        />
      </AppDataProvider>
    </AppErrorBoundary>
  );
}

function ShellInner({ route, setRoute, sidebarOpen, setSidebarOpen, sidebarCollapsed, setSidebarCollapsed, selectedChapterId, setSelectedChapterId, openQuestionId, setOpenQuestionId, selectedTestId, setSelectedTestId }) {
  const { loaded, createTask, createSession, settings } = useAppData();
  const current = NAV_SECTIONS.find((s) => s.id === route);

  function navigate(id) {
    setRoute(id);
    setSelectedChapterId(null);
    setOpenQuestionId(null);
    setSelectedTestId(null);
    setSidebarOpen(false);
  }

  function goToChapter(id) { setRoute("syllabus"); setSelectedChapterId(id); }
  function goToQuestion(q) { setRoute("questions"); setOpenQuestionId(q.id); }
  function goToTest(id) { setRoute("tests"); setSelectedTestId(id); }

  return (
    <div data-theme={(settings && settings.theme) || "dark"} className="flex h-full min-h-screen min-h-[640px] bg-[#0a0a0c] text-slate-200 font-sans">
      {/* Centralized color palette (STEP 10). This is a single-file Tailwind
          artifact, not a separate styles.css, so these variables document
          the theme; components mostly reference the equivalent Tailwind
          slate/indigo/emerald/amber/rose utility classes directly, which
          resolve to the same neutral-charcoal-with-indigo-accent palette. */}
      <style>{`
        :root {
          --bg: #0a0a0c;
          --surface: #16161a;
          --surface-2: #131316;
          --surface-3: #1c1c20;
          --border: #27272a;
          --text: #f1f5f9;
          --text-muted: #94a3b8;
          --accent: #6366f1;
          --accent-hover: #818cf8;
          --success: #10b981;
          --warning: #f59e0b;
          --danger: #f43f5e;
        }

        /* NIGHT — a deeper, lower-glare variant of the same Dark theme
           (STEP 11). Palette only: backgrounds go deeper near-black,
           borders/track fills get lower contrast, the brightest text and
           accent shades are dimmed one notch. Nothing else — no layout,
           component, or logic changes — is affected by this attribute. */
        [data-theme="night"] {
          --bg: #050506;
          --surface: #0a0a0c;
          --surface-2: #08080a;
          --surface-3: #101012;
          --border: #18181b;
          --text: #e4e4e7;
          --text-muted: #7d7d85;
          --accent: #6366f1;
          --accent-hover: #6366f1;
        }
        [data-theme="night"] .bg-\\[\\#0a0a0c\\] { background-color: #050506 !important; }
        [data-theme="night"] .bg-\\[\\#0d0d10\\] { background-color: #030304 !important; }
        [data-theme="night"] .bg-\\[\\#131316\\] { background-color: #08080a !important; }
        [data-theme="night"] .bg-\\[\\#16161a\\] { background-color: #0a0a0c !important; }
        [data-theme="night"] .bg-\\[\\#1c1c20\\] { background-color: #101012 !important; }

        [data-theme="night"] .border-slate-800,
        [data-theme="night"] .border-slate-800\\/50,
        [data-theme="night"] .border-slate-800\\/60,
        [data-theme="night"] .border-slate-800\\/80 { border-color: #18181b !important; }
        [data-theme="night"] .border-slate-700 { border-color: #1f1f23 !important; }
        [data-theme="night"] .border-slate-600 { border-color: #27272a !important; }

        [data-theme="night"] .bg-slate-800,
        [data-theme="night"] .bg-slate-800\\/30,
        [data-theme="night"] .bg-slate-800\\/50,
        [data-theme="night"] .bg-slate-800\\/60,
        [data-theme="night"] .bg-slate-800\\/80 { background-color: #131316 !important; }
        [data-theme="night"] .bg-slate-900 { background-color: #08080a !important; }

        [data-theme="night"] .text-slate-100 { color: #e4e4e7 !important; }
        [data-theme="night"] .text-slate-200 { color: #d4d4d8 !important; }

        [data-theme="night"] .bg-indigo-400 { background-color: #6366f1 !important; }
        [data-theme="night"] .border-indigo-400 { border-color: #6366f1 !important; }
        [data-theme="night"] .text-indigo-400 { color: #6366f1 !important; }
        [data-theme="night"] .accent-indigo-400 { accent-color: #6366f1 !important; }
      `}</style>
      {/* Sidebar — mobile: slide-over; desktop: collapsible icon rail */}
      <aside className={`
        fixed md:static inset-y-0 left-0 z-40 bg-[#0d0d10] border-r border-slate-800/80
        transform transition-all duration-200 md:translate-x-0
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}
        ${sidebarCollapsed ? "md:w-16" : "md:w-60"} w-60
      `}>
        <div className={`h-14 flex items-center gap-2 border-b border-slate-800/80 ${sidebarCollapsed ? "md:px-3 md:justify-center" : "px-5"}`}>
          <div className="w-6 h-6 rounded-md bg-indigo-400 flex items-center justify-center text-slate-950 text-xs font-bold flex-shrink-0">N</div>
          <span className={`font-semibold text-slate-100 text-sm tracking-wide ${sidebarCollapsed ? "md:hidden" : ""}`}>NEET Prep OS</span>
        </div>
        <nav className="py-2">
          {NAV_SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = route === s.id;
            return (
              <button
                key={s.id}
                onClick={() => navigate(s.id)}
                title={s.label}
                aria-label={s.label}
                className={`w-full flex items-center gap-3 py-2.5 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                  sidebarCollapsed ? "md:justify-center md:px-0 px-5" : "px-5"
                } ${
                  active ? "bg-indigo-400/10 text-indigo-300 border-r-2 border-indigo-400" : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                }`}
              >
                <Icon size={16} className="flex-shrink-0" />
                <span className={sidebarCollapsed ? "md:hidden" : ""}>{s.label}</span>
                {!s.ready && <span className={`ml-auto w-1.5 h-1.5 rounded-full bg-slate-700 ${sidebarCollapsed ? "md:hidden" : ""}`} />}
              </button>
            );
          })}
        </nav>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
        <header className="h-14 flex items-center gap-3 px-4 border-b border-slate-800/80 bg-[#0a0a0c]/95">
          <button
            className="text-slate-400 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 rounded p-1"
            aria-label="Toggle navigation"
            onClick={() => {
              // Mobile: open drawer; Desktop: collapse/expand rail
              if (typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches) {
                setSidebarCollapsed((v) => !v);
              } else {
                setSidebarOpen(true);
              }
            }}
          >
            <Menu size={20} />
          </button>
          <GlobalSearch onOpenChapter={goToChapter} onOpenQuestion={goToQuestion} onOpenTest={goToTest} onGoRoute={navigate} />
          <button
            onClick={() => navigate("dashboard")}
            className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5"
          >
            Today <ChevronRight size={12} />
          </button>
          <TimerBar />
          <QuickAdd onTask={createTask} onSession={createSession} />
        </header>

        <main className="flex-1 overflow-y-auto">
          {!loaded ? (
            <div className="h-full flex items-center justify-center text-slate-600 text-sm">Loading…</div>
          ) : route === "dashboard" ? (
            <Dashboard onOpenChapter={goToChapter} onOpenQuestion={goToQuestion} onOpenTest={goToTest} onOpenBacklog={() => navigate("backlog")} />
          ) : route === "settings" ? (
            <SettingsPage />
          ) : route === "syllabus" ? (
            selectedChapterId ? (
              <ChapterPage chapterId={selectedChapterId} onBack={() => setSelectedChapterId(null)} />
            ) : (
              <SyllabusPage onOpenChapter={setSelectedChapterId} />
            )
          ) : route === "resources" ? (
            <ResourcesPage onOpenChapter={(id) => { setRoute("syllabus"); setSelectedChapterId(id); }} />
          ) : route === "sessions" ? (
            <StudySessionsPage />
          ) : route === "calendar" ? (
            <CalendarPage />
          ) : route === "questions" ? (
            <QuestionsPage initialOpenId={openQuestionId} onConsumedInitial={() => setOpenQuestionId(null)} />
          ) : route === "important" ? (
            <ImportantPage />
          ) : route === "mistakes" ? (
            <MistakesPage />
          ) : route === "tests" ? (
            selectedTestId ? (
              <TestDetailPage testId={selectedTestId} onBack={() => setSelectedTestId(null)} onOpenChapter={goToChapter} onOpenQuestion={goToQuestion} />
            ) : (
              <TestsPage onOpenTest={setSelectedTestId} />
            )
          ) : route === "analytics" ? (
            <AnalyticsPage onOpenChapter={goToChapter} onOpenTest={goToTest} />
          ) : route === "backlog" ? (
            <BacklogPage />
          ) : route === "weekly-review" ? (
            <WeeklyReviewPage onOpenChapter={goToChapter} onOpenTest={goToTest} />
          ) : (
            <EmptyState label={current?.id} message="Page not found." />
          )}
        </main>
      </div>
      <StopConfirmModal />
    </div>
  );
}

export default App;
