// Owner screens for job-bound sending: Connect, Confirm job, Exceptions, Flight Recorder, Verify, and the front door.
// Plain React components with no framework-specific APIs, so a Next or Vite app can mount them.
export const PACKAGE_NAME = "@writ/job-send-ui";

export { NEVER_SAY, SAY, findNeverSay } from "./lib/copy";
export { formatExpiry } from "./lib/time";
export { buildTimeline, type ReceiptType, type TimelineReceipt, type TimelineRow } from "./lib/timeline";
export { wordDiff, type DiffSegment } from "./lib/wordDiff";
export { ConfirmJob, jobLists, type ConfirmJobProps, type JobDraft } from "./screens/ConfirmJob";
export { Connect, type ConnectProps } from "./screens/Connect";
export { ExceptionCard, type ExceptionCardProps, type PendingVersion } from "./screens/ExceptionCard";
export { FlightRecorder, type FlightRecorderProps } from "./screens/FlightRecorder";
export { VerifyPage, pinnedVerifier, type Pinned, type VerifyPageProps, type VerifyReceipt, type VerifyResult } from "./screens/VerifyPage";
export {
  AI_CHECK_LABELS,
  LINE_KIND_OPTIONS,
  LINKS_RULE,
  MAX_SENDS_LIMIT,
  MIN_CONFIDENCE,
  NEEDS_DETAIL,
  STARTER_PACK_LINES,
  chipFor,
  classifyLine,
  draftFrom,
  matchContacts,
  nextSendPhrase,
  parseLine,
  readLine,
  wallTimeToInstant,
  type AiCheck,
  type Chip,
  type ChipTone,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type Classify,
  type ClassifyRequest,
  type Contact,
  type DraftResult,
  type FrontDoorDraft,
  type Limit,
  type LineKind,
  type LineState,
  type ParseContext,
} from "./lib/frontDoor";
export { FrontDoor, type CompleteDraft, type FrontDoorProps } from "./screens/FrontDoor";
export { LiveJobForm, type LiveJobFormProps } from "./screens/LiveJobForm";
export {
  CHATGPT_CALLBACK,
  CONSENT_FORM_ACTION,
  CONSENT_SCOPE,
  Consent,
  ConsentForm,
  describeRedirect,
  type ConsentProps,
  type ConsentRequest,
  type ConsentView,
} from "./screens/Consent";
// renderConsentHtml (react-dom/server) is its own entry, "@writ/job-send-ui/consent-html", never this index.
export { approveWords, OwnerApp, type OwnerAppProps } from "./app/OwnerApp";
export {
  jobDraftBody,
  jobDraftFromAuthority,
  OwnerApi,
  jobFromApi,
  pendingFromApi,
  receiptFromApi,
  type ApiJobItem,
  type ApiPendingVersion,
  type ApiStoredReceipt,
  OwnerApiError,
  signInHref,
  type ApproveAnswer,
  type ConnectState,
  type CreatedJob,
  type JobDraftBody,
  type JobSummary,
  type ListedReceipt,
  type Owner,
} from "./app/api";
