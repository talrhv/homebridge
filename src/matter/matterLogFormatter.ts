/**
 * Matter.js Log Formatter
 *
 * Formats Matter.js library logs to match the homebridge log format and color scheme.
 * This ensures consistent logging output across Homebridge and Matter.js.
 */

import { Diagnostic } from '@matter/general'
import chalk from 'chalk'

import { Logger } from '../logger.js'

/**
 * Create a custom log formatter that matches the homebridge format.
 * Format: [timestamp] [Matter:Facility] message
 * Timestamp format matches system locale (via toLocaleString()).
 *
 * Log level color mapping:
 * - Matter DEBUG/INFO → gray (Homebridge debug)
 * - Matter NOTICE → no color (Homebridge info)
 * - Matter WARN → yellow (Homebridge warn)
 * - Matter ERROR/FATAL → red (Homebridge error)
 */
export function createHomebridgeLogFormatter(): (diagnostic: unknown) => string {
  // Capture timestamp setting once when formatter is created
  const timestampEnabled = Logger.isTimestampEnabled()

  return (diagnostic: unknown): string => {
    // Check if this is a Matter.js log message
    if (typeof diagnostic === 'object' && diagnostic !== null) {
      const msg = diagnostic as any

      // If it's a log message with the expected structure
      if (msg.now && msg.facility && msg.values) {
        // Format facility as [Matter:FacilityName] in cyan color
        const facility = formatCyan(`[Matter/${msg.facility}]`)

        // Extract the message text from values
        let messageText = formatMessageValues(msg.values)

        // Trim excessively long messages from verbose facilities like MessageChannel
        if (msg.facility === 'MessageChannel' && messageText.length > 200) {
          messageText = `${messageText.substring(0, 200)} [trimmed...]`
        }

        // Apply color based on Matter log level
        // Matter DEBUG/INFO → gray (Homebridge debug)
        // Matter NOTICE → no color (Homebridge info)
        // Matter WARN → yellow (Homebridge warn)
        // Matter ERROR/FATAL → red (Homebridge error)
        let coloredMessage = messageText
        if (msg.level !== undefined) {
          const levelStr = String(msg.level).toLowerCase()

          if (levelStr === 'debug' || levelStr === 'info') {
            // Homebridge debug style
            coloredMessage = chalk.gray(messageText)
          } else if (levelStr === 'warn') {
            // Homebridge warn style
            coloredMessage = chalk.yellow(messageText)
          } else if (levelStr === 'error' || levelStr === 'fatal') {
            // Homebridge error style
            coloredMessage = chalk.red(messageText)
          }
          // For 'notice' or anything else, leave it uncolored (Homebridge info style)
        }

        // Check if timestamps are enabled (respects --no-timestamp flag)
        if (timestampEnabled) {
          // Format timestamp to match Homebridge format using toLocaleString() in white
          const timestamp = formatHomebridgeTimestamp(msg.now)
          return `${timestamp} ${facility} ${coloredMessage}`
        } else {
          // No timestamp
          return `${facility} ${coloredMessage}`
        }
      }
    }

    // Fallback for non-message diagnostics
    return String(diagnostic)
  }
}

/**
 * Format a date object to Homebridge timestamp format.
 * Uses toLocaleString() to match the main logger's format and respect system locale/timezone.
 * Returns the timestamp in white color to match main logger.
 */
function formatHomebridgeTimestamp(date: Date): string {
  const timestamp = `[${date.toLocaleString()}]`
  return chalk.white(timestamp)
}

/**
 * Format text in cyan color using chalk
 */
function formatCyan(text: string): string {
  return chalk.cyan(text)
}

/**
 * Format the message values array into a readable string
 */
function formatMessageValues(values: unknown[]): string {
  if (!Array.isArray(values)) {
    return String(values)
  }

  return values
    .map((value) => {
      if (value === null) {
        return 'null'
      }
      if (value === undefined) {
        return 'undefined'
      }
      // Matter.js uses lazy logging - call functions to get the actual message
      if (typeof value === 'function') {
        try {
          return String(value())
        } catch {
          return String(value)
        }
      }
      if (typeof value === 'object') {
        // Check if this is a Matter.js Diagnostic object
        // These objects store their actual value in a symbol property
        const diagnosticValue = Diagnostic.valueOf(value)
        if (diagnosticValue !== undefined) {
          // Recursively format the diagnostic value
          return formatMessageValues([diagnosticValue])
        }

        // Special handling for Error objects
        if (value instanceof Error) {
          const errorDetails = {
            ...value, // Include any custom properties first
            name: value.name,
            message: value.message,
            stack: value.stack,
          }
          return JSON.stringify(errorDetails, null, 2)
        }
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      }
      return String(value)
    })
    .join(' ')
}
