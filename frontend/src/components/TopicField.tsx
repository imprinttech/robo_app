/**
 * TopicField.tsx — Topic + message-type selector for the Teleop tab.
 *
 * Features:
 *  - Dropdown populated from the backend's /api/topics/known, each entry
 *    showing "topic  (msg_type)".
 *  - A "Custom..." option that reveals free-text topic + msg_type inputs.
 *  - Persists the last-selected topic+msgType to localStorage and restores on mount.
 */

import React, { useEffect, useState } from "react";
import { fetchKnownTopics, type KnownTopic } from "../lib/api";

// ── Storage helpers ────────────────────────────────────────────────────────────

const LS_KEY_TOPIC    = "wrd:teleop:topic";
const LS_KEY_MSG_TYPE = "wrd:teleop:msgType";

function saveSelection(topic: string, msgType: string) {
  localStorage.setItem(LS_KEY_TOPIC,    topic);
  localStorage.setItem(LS_KEY_MSG_TYPE, msgType);
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface TopicFieldProps {
  onTopicChange: (topic: string, msgType: string) => void;
}

const CUSTOM_VALUE = "__custom__";
const CUSTOM_MSG_TYPES = ["geometry_msgs/msg/Twist", "geometry_msgs/msg/TwistStamped"];

// ── Component ─────────────────────────────────────────────────────────────────

export function TopicField({ onTopicChange }: TopicFieldProps) {
  const [knownTopics, setKnownTopics] = useState<KnownTopic[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);

  // Selected value in the main dropdown  ("topic|msgType"  or  "__custom__")
  const [selected, setSelected]     = useState<string>("");
  // Custom topic + msgType (visible only when selected === CUSTOM_VALUE)
  const [customTopic,   setCustomTopic]   = useState("");
  const [customMsgType, setCustomMsgType] = useState(CUSTOM_MSG_TYPES[0]);

  // Load known topics from backend
  useEffect(() => {
    fetchKnownTopics()
      .then((topics) => {
        setKnownTopics(topics);

        // Restore persisted selection
        const savedTopic   = localStorage.getItem(LS_KEY_TOPIC)    ?? "";
        const savedMsgType = localStorage.getItem(LS_KEY_MSG_TYPE)  ?? "";

        const matchedKnown = topics.find(
          (t) => t.topic === savedTopic && t.msg_type === savedMsgType
        );

        if (matchedKnown) {
          const val = `${matchedKnown.topic}|${matchedKnown.msg_type}`;
          setSelected(val);
          onTopicChange(matchedKnown.topic, matchedKnown.msg_type);
        } else if (savedTopic) {
          // Was a custom topic
          setSelected(CUSTOM_VALUE);
          setCustomTopic(savedTopic);
          setCustomMsgType(savedMsgType || CUSTOM_MSG_TYPES[0]);
          onTopicChange(savedTopic, savedMsgType || CUSTOM_MSG_TYPES[0]);
        } else if (topics.length > 0) {
          // Default to first known topic
          const def = topics[0];
          const val = `${def.topic}|${def.msg_type}`;
          setSelected(val);
          onTopicChange(def.topic, def.msg_type);
          saveSelection(def.topic, def.msg_type);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function handleDropdownChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const val = e.target.value;
    setSelected(val);
    if (val !== CUSTOM_VALUE) {
      const [topic, msgType] = val.split("|");
      onTopicChange(topic, msgType);
      saveSelection(topic, msgType);
    }
  }

  function handleCustomTopicChange(e: React.ChangeEvent<HTMLInputElement>) {
    const t = e.target.value;
    setCustomTopic(t);
    onTopicChange(t, customMsgType);
    saveSelection(t, customMsgType);
  }

  function handleCustomMsgTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const mt = e.target.value;
    setCustomMsgType(mt);
    onTopicChange(customTopic, mt);
    saveSelection(customTopic, mt);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="topic-field">
      <label className="topic-field__label">
        <span>Publish Topic</span>
        {error && <span className="topic-field__error">⚠ {error}</span>}
      </label>

      <div className="topic-field__row">
        <select
          id="topic-select"
          className="topic-field__select"
          value={selected}
          onChange={handleDropdownChange}
          disabled={loading}
          aria-label="Select publish topic"
        >
          {loading && <option>Loading topics…</option>}
          {knownTopics.map((t) => {
            const val = `${t.topic}|${t.msg_type}`;
            return (
              <option key={val} value={val}>
                {t.topic}  ({t.msg_type.split("/").pop()})
              </option>
            );
          })}
          <option value={CUSTOM_VALUE}>Custom…</option>
        </select>
      </div>

      {selected === CUSTOM_VALUE && (
        <div className="topic-field__custom">
          <input
            className="topic-field__input"
            type="text"
            placeholder="/cmd_vel_teleop"
            value={customTopic}
            onChange={handleCustomTopicChange}
            aria-label="Custom topic name"
          />
          <select
            className="topic-field__select"
            value={customMsgType}
            onChange={handleCustomMsgTypeChange}
            aria-label="Custom message type"
          >
            {CUSTOM_MSG_TYPES.map((mt) => (
              <option key={mt} value={mt}>
                {mt.split("/").pop()}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
