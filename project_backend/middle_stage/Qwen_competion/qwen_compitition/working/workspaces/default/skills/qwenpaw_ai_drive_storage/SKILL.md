---
name: qwenpaw_ai_drive_storage
description: "Use whenever the user uploads or attaches a file, image, document, spreadsheet, presentation, archive, audio, or video in QwenPaw and wants it saved, organized, classified, summarized, or managed in AI Drive. QwenPaw must perform the analysis; AI Drive is storage and visualization only."
metadata:
  version: "1.0"
---

# QwenPaw AI Drive storage

QwenPaw is the source of truth for analysing every uploaded attachment. AI Drive is only the persistent visual file library.

## Required workflow for every attachment

1. Use the attachment's local `file://` URL or absolute local path supplied in the chat.
2. Read or analyse the file using QwenPaw's own tools and the applicable file skill.
3. Decide a useful human-facing category, a virtual path, a concise summary, tags, and key points.
4. Call `ai-drive__ai_drive_store_from_qwenpaw` exactly once for the original attachment.
5. Tell the user the resulting category and storage path returned by the tool.

Never call AI Drive's question-answering, embedding, indexing, parsing, or classification APIs for this workflow. Do not ask the user to upload the same file separately in AI Drive.

## Metadata rules

- `category_key`: a stable lowercase identifier such as `project`, `contract`, `finance`, `research`, `image`, or `personal`.
- `category_label`: a short Chinese label shown in AI Drive, such as `项目资料` or `合同`.
- `virtual_path`: an absolute display path ending in the filename, for example `/工作/合同/2026/采购合同.pdf`.
- `summary`: describe the actual content, not only the file type.
- `tags`, `key_points`, and `questions`: concise Chinese string lists. Use an empty list if unavailable.
- `qwenpaw_model`: use the active model name when available.

## Important

If a file cannot be read fully, still store it. Be honest in the summary about the limitation and classify it from the reliable information available. For images, do not claim visual details unless the active QwenPaw model or a local tool actually inspected the image.
