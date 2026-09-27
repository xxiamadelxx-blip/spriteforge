const COMPONENTS = new Set(['android', 'relay']);
const TERMINAL_EVENTS = new Set(['rejected', 'failed', 'legacy_unverified']);

export class ReleaseLedgerError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function requireText(value, code) {
  if (typeof value !== 'string' || value.trim() === '') throw new ReleaseLedgerError(code);
  return value.trim();
}

function requireComponent(component) {
  if (!COMPONENTS.has(component)) throw new ReleaseLedgerError('RELEASE_COMPONENT_INVALID');
  return component;
}

function clone(value) {
  return structuredClone(value);
}

function pointerContract(name) {
  if (name === 'accepted_android') return { component: 'android', eventType: 'accepted' };
  if (name === 'accepted_relay') return { component: 'relay', eventType: 'accepted' };
  if (name === 'running_relay') return { component: 'relay', eventType: 'deployed' };
  throw new ReleaseLedgerError('RELEASE_POINTER_INVALID');
}

export class ReleaseLedger {
  #operators = new Set();
  #releases = new Map();
  #events = new Map();
  #eventsByRelease = new Map();
  #requestsByIdempotencyKey = new Map();
  #requestsById = new Map();
  #requestByFingerprint = new Map();
  #pointers = new Map([
    ['accepted_android', { revision: 0, releaseId: null, eventId: null }],
    ['accepted_relay', { revision: 0, releaseId: null, eventId: null }],
    ['running_relay', { revision: 0, releaseId: null, eventId: null }],
  ]);
  #pointerEvents = [];
  #nextId = 1;

  constructor({ operatorIds = [], idFactory = null } = {}) {
    for (const operatorId of operatorIds) this.#operators.add(requireText(operatorId, 'OPERATOR_ID_REQUIRED'));
    this.idFactory = idFactory || ((kind) => `${kind}-${this.#nextId++}`);
  }

  #assertOperator(actorId) {
    if (!this.#operators.has(actorId)) throw new ReleaseLedgerError('RELEASE_OPERATOR_REQUIRED');
  }

  #lastEvent(releaseId) {
    const ids = this.#eventsByRelease.get(releaseId) || [];
    return ids.length ? this.#events.get(ids.at(-1)) : null;
  }

  createRelease({ actorId, component, releaseIdentity, sourceRepo = null, sourceSha = null, metadata = {} }) {
    this.#assertOperator(actorId);
    component = requireComponent(component);
    releaseIdentity = requireText(releaseIdentity, 'RELEASE_IDENTITY_REQUIRED');
    if (sourceSha !== null && !/^[0-9a-f]{40}$/i.test(sourceSha)) throw new ReleaseLedgerError('SOURCE_SHA_INVALID');
    sourceSha = sourceSha?.toLowerCase() || null;
    const existing = [...this.#releases.values()].find((release) => release.releaseIdentity === releaseIdentity);
    if (existing) {
      if (existing.component !== component || existing.sourceRepo !== sourceRepo || existing.sourceSha !== sourceSha) {
        throw new ReleaseLedgerError('RELEASE_IDENTITY_CONFLICT');
      }
      return clone(existing);
    }
    const release = {
      releaseId: this.idFactory('release'), component, releaseIdentity, sourceRepo, sourceSha,
      metadata: clone(metadata), createdBy: actorId,
    };
    this.#releases.set(release.releaseId, release);
    this.#eventsByRelease.set(release.releaseId, []);
    return clone(release);
  }

  appendEvent({ actorId, releaseId, eventType, reason, evidence = {} }) {
    this.#assertOperator(actorId);
    const release = this.#releases.get(releaseId);
    if (!release) throw new ReleaseLedgerError('RELEASE_NOT_FOUND');
    requireText(reason, 'RELEASE_EVENT_REASON_REQUIRED');
    const prior = this.#lastEvent(releaseId);
    if (prior && TERMINAL_EVENTS.has(prior.eventType)) throw new ReleaseLedgerError('RELEASE_TERMINAL');
    const priorType = prior?.eventType || null;
    const valid = (
      (eventType === 'candidate_verified' && priorType === null)
      || (eventType === 'accepted' && priorType === 'candidate_verified')
      || (eventType === 'deployed' && release.component === 'relay' && priorType === 'accepted')
      || (eventType === 'installed' && release.component === 'android' && priorType === 'accepted')
      || (eventType === 'legacy_observed' && priorType === null && release.releaseIdentity.startsWith('legacy:'))
      || (eventType === 'legacy_unverified' && priorType === 'legacy_observed')
      || ((eventType === 'rejected' || eventType === 'failed') && (priorType === null || priorType === 'candidate_verified'))
    );
    if (!valid) throw new ReleaseLedgerError('RELEASE_EVENT_TRANSITION_INVALID');
    const event = { eventId: this.idFactory('event'), releaseId, eventType, reason: reason.trim(), evidence: clone(evidence), actorId };
    this.#events.set(event.eventId, event);
    this.#eventsByRelease.get(releaseId).push(event.eventId);
    return clone(event);
  }

  request({ actorId, component, sourceSha, workflowId, buildProfile, idempotencyKey, attemptId, retryOf = null, retryReason = null }) {
    this.#assertOperator(actorId);
    component = requireComponent(component);
    if (!/^[0-9a-f]{40}$/i.test(sourceSha || '')) throw new ReleaseLedgerError('SOURCE_SHA_INVALID');
    workflowId = requireText(workflowId, 'WORKFLOW_ID_REQUIRED');
    buildProfile = requireText(buildProfile, 'BUILD_PROFILE_REQUIRED');
    idempotencyKey = requireText(idempotencyKey, 'IDEMPOTENCY_KEY_REQUIRED');
    attemptId = requireText(attemptId, 'ATTEMPT_ID_REQUIRED');
    const idempotent = this.#requestsByIdempotencyKey.get(idempotencyKey);
    if (idempotent) return clone(idempotent);
    sourceSha = sourceSha.toLowerCase();
    const fingerprint = `${component}:${sourceSha}:${workflowId}:${buildProfile}`;
    const previous = this.#requestByFingerprint.get(fingerprint);
    if (previous) {
      if (!['failed', 'rejected'].includes(previous.lifecycle)) return clone(previous);
      if (retryOf !== previous.requestId || typeof retryReason !== 'string' || retryReason.trim() === '') {
        throw new ReleaseLedgerError('RETRY_REQUIRES_TERMINAL_PREDECESSOR');
      }
    } else if (retryOf || retryReason) {
      throw new ReleaseLedgerError('RETRY_PREDECESSOR_NOT_FOUND');
    }
    const request = {
      requestId: this.idFactory('request'), component, sourceSha: sourceSha.toLowerCase(), workflowId, buildProfile,
      idempotencyKey, attemptId, retryOf, retryReason: retryReason?.trim() || null, lifecycle: 'recorded', actorId,
    };
    this.#requestsByIdempotencyKey.set(idempotencyKey, request);
    this.#requestsById.set(request.requestId, request);
    this.#requestByFingerprint.set(fingerprint, request);
    return clone(request);
  }

  transitionRequest({ actorId, requestId, expectedLifecycle, nextLifecycle }) {
    this.#assertOperator(actorId);
    const request = this.#requestsById.get(requestId);
    if (!request) throw new ReleaseLedgerError('RELEASE_REQUEST_NOT_FOUND');
    if (request.lifecycle !== expectedLifecycle) throw new ReleaseLedgerError('RELEASE_REQUEST_CONFLICT');
    const allowed = (expectedLifecycle === 'recorded' && ['running', 'failed', 'rejected'].includes(nextLifecycle))
      || (expectedLifecycle === 'running' && ['succeeded', 'failed', 'rejected'].includes(nextLifecycle));
    if (!allowed) throw new ReleaseLedgerError('RELEASE_REQUEST_TRANSITION_INVALID');
    request.lifecycle = nextLifecycle;
    return clone(request);
  }

  compareAndSwapPointer({ actorId, pointerName, releaseId, eventId, expectedRevision, reason }) {
    this.#assertOperator(actorId);
    requireText(reason, 'RELEASE_POINTER_REASON_REQUIRED');
    const contract = pointerContract(pointerName);
    const pointer = this.#pointers.get(pointerName);
    if (pointer.revision !== expectedRevision) throw new ReleaseLedgerError('RELEASE_POINTER_CONFLICT');
    const release = this.#releases.get(releaseId);
    const event = this.#events.get(eventId);
    if (!release || !event || event.releaseId !== releaseId || release.component !== contract.component || event.eventType !== contract.eventType) {
      throw new ReleaseLedgerError('RELEASE_POINTER_TARGET_INVALID');
    }
    const prior = clone(pointer);
    pointer.releaseId = releaseId;
    pointer.eventId = eventId;
    pointer.revision += 1;
    this.#pointerEvents.push({ pointerName, priorRevision: prior.revision, nextRevision: pointer.revision, prior, next: clone(pointer), actorId, reason: reason.trim() });
    return clone(pointer);
  }

  getPointer(pointerName) {
    pointerContract(pointerName);
    return clone(this.#pointers.get(pointerName));
  }
  getPointerEvents() { return clone(this.#pointerEvents); }
}
