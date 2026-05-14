# FF4 VIR Lorebook Sync

**FF4 VIR Lorebook Sync** is a powerful SillyTavern extension designed to automate the management of character visual identities within the "Frankenstein 4" (FF4) prompting ecosystem. It ensures that character appearances remain consistent and state-aware by synchronizing Visual Identity Registry (VIR) data directly into specialized Lorebooks.

## 🚀 Key Features

- **Peak Unrestricted RP Engine**: Strict token discipline with 70-80% overhead reduction.
- **Dynamic Watchdogs**: Real-time detection of banned vocabulary, repetition, shape monotony, and user-input echoing.
- **Unified State Builder**: Consolidates scene, time, geometry, and relationships into a single efficient block.
- **Character State Machine**: Tracks injuries, fluids, and emotional registers with automated decay.
- **Advanced Mode Sync**: Extension-driven control over agency modes, cynicism, and POV/tense modifiers.

## 🛠️ Installation

1. Copy the `ff4-vir-lorebook-sync` folder into your SillyTavern `public/scripts/extensions/third-party/` directory.
2. Restart SillyTavern.
3. Enable the extension in the Extensions menu.

## 📖 Usage

The extension operates silently in the background. When a model outputs a VIR block:

```xml
<vir_sync>
{
  "name": "Elysia",
  "vir": {
    "species": "Elf",
    "hair": "Silver, waist-length",
    "eyes": "Emerald green",
    "outfit": "White silk traveler's cloak"
  }
}
</vir_sync>
```

The extension will immediately update the active Lorebook for that chat, ensuring subsequent prompts include the updated visual information.

## ⚙️ Configuration

Available in the extension settings panel:
- **Enable/Disable**: Toggle the entire sync engine.
- **Debug Mode**: Detailed logging and toast notifications for sync events.
- **Auto-Hide Packets**: Automatically hides the `<vir_sync>` XML blocks from the chat UI for a cleaner experience.
- **Cleanup on Delete**: Automatically deletes associated VIR Lorebooks when a chat is removed.

## 📝 Requirements

- SillyTavern 1.12.0 or higher.
- Compatible with FF4-style visual output protocols.

---
**Author:** [ets1odoo-beep](https://github.com/ets1odoo-beep)  
**Version:** 4.0.0
