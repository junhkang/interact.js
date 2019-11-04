import * as utils from '@interactjs/utils'
import InteractableMethods from './InteractableMethods'

declare module '@interactjs/interact/interact' {
  interface InteractStatic {
    maxInteractions: (newValue: any) => any
  }
}

declare module '@interactjs/core/scope' {
  interface Scope {
    autoStart: AutoStart
    maxInteractions: (...args: any) => any
  }
}

declare module '@interactjs/core/defaultOptions' {
  interface BaseDefaults {
    actionChecker?
    styleCursor?
  }

  interface PerActionDefaults {
    manualStart?: boolean
    max?: number
    maxPerElement?: number
    allowFrom?: string | Interact.Element
    ignoreFrom?: string | Interact.Element

    // only allow left button by default
    // see https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons#Return_value
    mouseButtons?: 0 | 1 | 2 | 4 | 16
  }
}

export interface AutoStart {
  // Allow this many interactions to happen simultaneously
  maxInteractions: number
  withinInteractionLimit: typeof withinInteractionLimit
  cursorElement: Interact.Element
  signals: utils.Signals
}

function install (scope: Interact.Scope) {
  const {
    interact,
    signals,
    defaults,
  } = scope

  scope.usePlugin(InteractableMethods)

  signals.addHandler({
    'interactions:down': arg => prepareOnDown(arg as Interact.SignalArg, scope),
    'interactions:move': (arg: Interact.SignalArg) => {
      prepareOnMove(arg, scope)
      startOnMove(arg, scope)
    },
    'interactions:stop': arg => clearCursorOnStop(arg as Interact.SignalArg, scope),
  })

  defaults.base.actionChecker = null
  defaults.base.styleCursor = true

  utils.extend(defaults.perAction, {
    manualStart: false,
    max: Infinity,
    maxPerElement: 1,
    allowFrom:  null,
    ignoreFrom: null,

    // only allow left button by default
    // see https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/buttons#Return_value
    mouseButtons: 1,
  })

  /**
   * Returns or sets the maximum number of concurrent interactions allowed.  By
   * default only 1 interaction is allowed at a time (for backwards
   * compatibility). To allow multiple interactions on the same Interactables and
   * elements, you need to enable it in the draggable, resizable and gesturable
   * `'max'` and `'maxPerElement'` options.
   *
   * @alias module:interact.maxInteractions
   *
   * @param {number} [newValue] Any number. newValue <= 0 means no interactions.
   */
  interact.maxInteractions = newValue => maxInteractions(newValue, scope)

  scope.autoStart = {
    // Allow this many interactions to happen simultaneously
    maxInteractions: Infinity,
    withinInteractionLimit,
    cursorElement: null,
    signals: new utils.Signals(),
  }
}

function prepareOnDown ({ interaction, pointer, event, eventTarget }: Interact.SignalArg, scope: Interact.Scope) {
  if (interaction.interacting()) { return }

  const actionInfo = getActionInfo(interaction, pointer, event, eventTarget, scope)
  prepare(interaction, actionInfo, scope)
}

function prepareOnMove ({ interaction, pointer, event, eventTarget }: Interact.SignalArg, scope: Interact.Scope) {
  if (interaction.pointerType !== 'mouse' ||
      interaction.pointerIsDown ||
      interaction.interacting()) { return }

  const actionInfo = getActionInfo(interaction, pointer, event, eventTarget, scope)
  prepare(interaction, actionInfo, scope)
}

function startOnMove (arg: Interact.SignalArg, scope: Interact.Scope) {
  const { interaction } = arg

  if (!interaction.pointerIsDown ||
      interaction.interacting() ||
      !interaction.pointerWasMoved ||
      !interaction.prepared.name) {
    return
  }

  scope.signals.fire('autoStart:before-start', arg)

  const { interactable } = interaction

  if (interaction.prepared.name && interactable) {
    // check manualStart and interaction limit
    if (interactable.options[interaction.prepared.name].manualStart ||
        !withinInteractionLimit(interactable, interaction.element, interaction.prepared, scope)) {
      interaction.stop()
    }
    else {
      interaction.start(interaction.prepared, interactable, interaction.element)
      setInteractionCursor(interaction, scope)
    }
  }
}

function clearCursorOnStop ({ interaction }: { interaction: Interact.Interaction }, scope: Interact.Scope) {
  const { interactable } = interaction

  if (interactable && interactable.options.styleCursor) {
    setCursor(interaction.element, '', scope)
  }
}

// Check if the current interactable supports the action.
// If so, return the validated action. Otherwise, return null
function validateAction (
  action: Interact.ActionProps,
  interactable: Interact.Interactable,
  element: Interact.Element,
  eventTarget: Interact.Element,
  scope: Interact.Scope,
) {
  if (interactable.testIgnoreAllow(interactable.options[action.name], element, eventTarget) &&
      interactable.options[action.name].enabled &&
      withinInteractionLimit(interactable, element, action, scope)) {
    return action
  }

  return null
}

function validateMatches (
  interaction: Interact.Interaction,
  pointer,
  event,
  matches: Interact.Interactable[],
  matchElements: Interact.Element[],
  eventTarget: Interact.Element,
  scope: Interact.Scope,
) {
  for (let i = 0, len = matches.length; i < len; i++) {
    const match = matches[i]
    const matchElement = matchElements[i]
    const matchAction = match.getAction(pointer, event, interaction, matchElement)

    if (!matchAction) { continue }

    const action = validateAction(
      matchAction,
      match,
      matchElement,
      eventTarget,
      scope)

    if (action) {
      return {
        action,
        interactable: match,
        element: matchElement,
      }
    }
  }

  return { action: null, interactable: null, element: null }
}

function getActionInfo (
  interaction: Interact.Interaction,
  pointer: Interact.PointerType,
  event: Interact.PointerEventType,
  eventTarget: Interact.Element,
  scope: Interact.Scope,
) {
  let matches = []
  let matchElements = []

  let element = eventTarget

  function pushMatches (interactable) {
    matches.push(interactable)
    matchElements.push(element)
  }

  while (utils.is.element(element)) {
    matches = []
    matchElements = []

    scope.interactables.forEachMatch(element, pushMatches)

    const actionInfo = validateMatches(interaction, pointer, event, matches, matchElements, eventTarget, scope)

    if (actionInfo.action &&
      !actionInfo.interactable.options[actionInfo.action.name].manualStart) {
      return actionInfo
    }

    element = utils.dom.parentNode(element)
  }

  return { action: null, interactable: null, element: null }
}

function prepare (
  interaction: Interact.Interaction,
  { action, interactable, element }: {
    action: Interact.ActionProps
    interactable: Interact.Interactable
    element: Interact.Element
  },
  scope: Interact.Scope,
) {
  action = action || { name: null }

  // clear previous target element cursor
  if (interaction.interactable && interaction.interactable.options.styleCursor) {
    setCursor(interaction.element, '', scope)
  }

  interaction.interactable = interactable
  interaction.element = element
  utils.copyAction(interaction.prepared, action)

  interaction.rect = interactable && action.name
    ? interactable.getRect(element)
    : null

  setInteractionCursor(interaction, scope)

  scope.signals.fire('autoStart:prepared', { interaction })
}

function withinInteractionLimit (interactable: Interact.Interactable, element: Interact.Element, action, scope: Interact.Scope) {
  const options = interactable.options
  const maxActions = options[action.name].max
  const maxPerElement = options[action.name].maxPerElement
  const autoStartMax = scope.autoStart.maxInteractions
  let activeInteractions = 0
  let interactableCount = 0
  let elementCount = 0

  // no actions if any of these values == 0
  if (!(maxActions && maxPerElement && autoStartMax)) { return false }

  for (const interaction of scope.interactions.list) {
    const otherAction = interaction.prepared.name

    if (!interaction.interacting()) { continue }

    activeInteractions++

    if (activeInteractions >= autoStartMax) {
      return false
    }

    if (interaction.interactable !== interactable) { continue }

    interactableCount += otherAction === action.name ? 1 : 0

    if (interactableCount >= maxActions) {
      return false
    }

    if (interaction.element === element) {
      elementCount++

      if (otherAction === action.name && elementCount >= maxPerElement) {
        return false
      }
    }
  }

  return autoStartMax > 0
}

function maxInteractions (newValue, scope: Interact.Scope) {
  if (utils.is.number(newValue)) {
    scope.autoStart.maxInteractions = newValue

    return this
  }

  return scope.autoStart.maxInteractions
}

function setCursor (element: Interact.Element, cursor, scope: Interact.Scope) {
  if (scope.autoStart.cursorElement) {
    scope.autoStart.cursorElement.style.cursor = ''
  }

  element.ownerDocument.documentElement.style.cursor = cursor
  element.style.cursor = cursor
  scope.autoStart.cursorElement = cursor ? element : null
}

function setInteractionCursor (interaction: Interact.Interaction, scope: Interact.Scope) {
  const { interactable, element, prepared } = interaction

  if (!(interaction.pointerType === 'mouse' && interactable && interactable.options.styleCursor)) {
    return
  }

  let cursor = ''

  if (prepared.name) {
    const cursorChecker: Interact.CursorChecker = interactable.options[prepared.name].cursorChecker

    if (utils.is.func(cursorChecker)) {
      cursor = cursorChecker(prepared, interactable, element, interaction._interacting)
    }
    else {
      cursor = scope.actions[prepared.name].getCursor(prepared)
    }
  }

  setCursor(interaction.element, cursor || '', scope)
}

export default {
  id: 'auto-start/base',
  install,
  maxInteractions,
  withinInteractionLimit,
  validateAction,
} as Interact.Plugin
