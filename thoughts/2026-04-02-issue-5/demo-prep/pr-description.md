# Add Persistent Retry System for Failed Outreach

## Summary

Implements a comprehensive retry mechanism for failed communication outreach that persists across daemon restarts and respects plugin-blindness principles. When message delivery fails (e.g., Telegram user unreachable), the system now automatically schedules retry attempts at configurable intervals (default: 30 seconds) while the task remains active.

**Key Changes:**
- **RetryManager subsystem** with persistent state management and adaptive backoff
- **Enhanced NotificationRouter** to capture failed deliveries and schedule retries
- **Plugin-blind design** using only CommunicationAdapter contract fields
- **Event-driven integration** with task state changes and observability events
- **Configurable retry policies** with sensible defaults

## Technical Approach

### Architecture Overview

Following the established three-tier model and plugin-blindness principle, the retry system works entirely through the existing `CommunicationAdapter` contract without knowing about specific plugins:

1. **NotificationRouter** captures failed delivery attempts instead of discarding them
2. **RetryManager** schedules and manages retry attempts with persistent state
3. **Daemon integration** processes retries through the existing tick loop
4. **Event system** coordinates state changes and provides observability

### Core Components Added

#### 1. RetryManager (`src/core/daemon/retry-manager.ts`)
- **Persistent state** management with JSON file storage
- **Adaptive backoff** with exponential increase up to configurable maximum
- **Plugin-respect** for `AdapterError.retry_after` timing recommendations
- **Task lifecycle** awareness - stops retries when tasks complete/fail
- **Statistics tracking** for observability

#### 2. Retry Schemas (`src/schemas/retry.ts`)
- **RetryScheduleEntry** tracks individual retry schedules
- **RetryConfig** provides configurable retry behavior
- **RetryAttempt** history for debugging and analytics
- **Comprehensive validation** using Zod schemas

#### 3. Enhanced NotificationRouter
- **Delivery result tracking** captures `AdapterError.retryable` and `retry_after` fields
- **Retry scheduling** for failed deliveries to retryable contacts
- **Fallback preservation** - maintains existing contact priority logic
- **Error handling** distinguishes retryable vs permanent failures

### Configuration

New retry configuration in `DaemonConfig.retry`:

```typescript
{
  outreach_retry_interval_ms: 30_000,     // 30 second default interval
  max_outreach_retry_attempts: null,      // Unlimited while task active
  adaptive_backoff_enabled: true,         // Exponential backoff
  max_backoff_interval_ms: 300_000        // 5 minute max interval
}
```

### Event Integration

New observability events:
- `outreach.retry_scheduled` - When a retry is scheduled
- `outreach.retry_succeeded` - When a retry delivers successfully
- `outreach.retry_abandoned` - When retries are given up

Event-driven cleanup:
- Subscribes to `task.state_changed` to stop retries for completed/failed tasks
- Emits `comm.message_sent` events for successful retry deliveries

## How to Test

### 1. Basic Retry Flow
```bash
# Set up a task with outreach to an unreachable Telegram user
# Verify retry attempts happen every 30 seconds
# Verify retries stop when user becomes reachable
```

### 2. Task State Integration  
```bash
# Start outreach with failed delivery
# Complete/fail the task
# Verify retry schedules are immediately cleaned up
```

### 3. Daemon Restart Persistence
```bash
# Start outreach with active retries
# Restart daemon
# Verify retry schedules are preserved and resumed
```

### 4. Plugin Blindness
```bash
# Test with multiple communication plugins
# Verify retry logic works identically regardless of plugin type
# Verify plugin-specific retry_after timing is respected
```

### 5. Adaptive Backoff
```bash
# Cause multiple consecutive failures to same contact
# Verify retry intervals increase exponentially (30s → 1m → 2m → 4m → 5m max)
# Verify plugin-specified retry_after overrides backoff timing
```

## Breaking Changes

**None.** This is a pure enhancement that maintains full backward compatibility:

- Existing successful delivery flows are unchanged
- Failed deliveries that were previously logged and discarded now trigger retries
- No configuration changes required - retry system works with defaults
- No plugin contract changes - uses existing `AdapterError.retryable` fields

## Deployment Notes

### Database/Storage
- Creates `retry-state.json` in daemon data directory for persistent state
- File is created automatically on first retry schedule
- No migration required

### Performance Impact
- Minimal - retry processing happens during existing daemon tick loop
- Retry attempts are processed sequentially to avoid plugin overload
- State file is only written when retry schedules change

### Configuration
Default configuration provides sensible behavior out of the box:
- 30 second retry intervals
- Unlimited retries while tasks are active  
- Automatic cleanup when tasks complete
- 5 minute maximum backoff interval

Can be customized in daemon config if needed:
```json
{
  "retry": {
    "outreach_retry_interval_ms": 60000,
    "max_outreach_retry_attempts": 10
  }
}
```

## Key Implementation Decisions

### 1. Plugin Blindness Compliance
- **Decision:** Use only `CommunicationAdapter.sendMessage()` results and `AdapterError` fields
- **Rationale:** Maintains architecture principle that Core never knows about specific plugins
- **Implementation:** Retry logic works through adapter contract exclusively

### 2. Retry Target Selection
- **Decision:** Retry the first retryable contact (preferred contact priority)
- **Rationale:** Respects user's contact preferences while avoiding duplicate delivery
- **Implementation:** Fallback chain logic preserved, retry focuses on preferred channel

### 3. State Persistence Strategy
- **Decision:** JSON file storage following existing daemon patterns  
- **Rationale:** Consistent with other Core components, survives restarts, human-readable
- **Implementation:** File saved on state changes, loaded on startup

### 4. Event-Driven Cleanup
- **Decision:** Subscribe to `task.state_changed` events for immediate cleanup
- **Rationale:** Prevents unnecessary retry attempts when tasks complete
- **Implementation:** Reactive cleanup plus periodic cleanup for robustness

### 5. Adaptive Backoff Policy
- **Decision:** Exponential backoff with plugin override capability
- **Rationale:** Prevents spam while respecting plugin-specific timing needs
- **Implementation:** Doubles interval up to max, honors `retry_after_ms` from plugins

## Future Enhancements

This implementation provides a solid foundation that could be extended with:

- **Retry analytics** - Success/failure rates by channel and time
- **Contact availability detection** - Enhanced plugin contract for presence awareness  
- **Retry prioritization** - Different intervals for different notification types
- **Retry batching** - Group retries to reduce plugin load

The plugin-blind design ensures these enhancements would work across all communication channels without plugin-specific code.

---

**Full implementation details and phase-by-phase development notes are available in the `thoughts/` directory.**