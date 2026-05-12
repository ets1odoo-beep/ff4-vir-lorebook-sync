# FF4 VIR Lorebook Sync

**FF4 VIR Lorebook Sync** is a powerful SillyTavern extension designed to automate the management of character visual identities within the "Frankenstein 4" (FF4) prompting ecosystem. It ensures that character appearances remain consistent and state-aware by synchronizing Visual Identity Registry (VIR) data directly into specialized Lorebooks.

## 🚀 Key Features

- **Automated Synchronization**: Automatically detects `<vir_sync>` packets in model responses and updates character entries in real-time.
- **Dynamic Lorebook Management**: Creates and maintains chat-specific Lorebooks (prefixed with `FF4 VIR - `) to prevent attribute leakage between different stories.
- **Visual Trait Enforcement**: Tracks mandatory fields such as `species`, `height`, `hair`, `eyes`, `skin_fur_scales`, and `outfit`.
- **Narrative Consistency**: Handles complex identity canonicalization, stripping scenario noise and normalizing character names for perfect prompt matching.
- **Auto-Cleanup**: Intelligently removes orphaned Lorebooks when chats are deleted to keep your "Worlds" directory clean.
- **Debug & Monitoring**: Built-in status tracking and warning system to alert you when visual traits are missing or malformed.

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
**Version:** 1.0.0
