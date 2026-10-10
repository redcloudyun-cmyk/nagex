package com.nagex.mobile

import android.view.accessibility.AccessibilityNodeInfo
import java.text.Normalizer

class KakaoTalkConversationClassifier {

    enum class TargetType { DIRECT, GROUP, OPEN_CHAT, CHANNEL, UNKNOWN }
    enum class Resolution { CANDIDATE_FOUND, NOT_FOUND, AMBIGUOUS }

    data class ConversationCandidate(
        val targetType: TargetType,
        val providerDisplayName: String,
        val conversationTitle: String,
        val participantHints: List<String>,
        val clickableNode: AccessibilityNodeInfo?,
        val evidence: String,
        val reason: String,
        val targetEvidence: ConversationTargetEvidence,
    )

    data class ConversationTargetEvidence(
        val targetType: TargetType,
        val providerDisplayName: String,
        val normalizedIdentity: String,
        val rowFingerprint: String,
        val semanticRowText: String,
        val structuralPath: String,
        val clickableCandidateEvidence: String,
    )

    data class DirectResolution(
        val status: Resolution,
        val directCandidates: List<ConversationCandidate>,
        val blockedCandidates: List<ConversationCandidate>,
    )

    data class ObservedRow(
        val sectionTitle: String?,
        val primaryText: String,
        val secondaryText: String = "",
        val contentDescription: String = "",
        val clickableNode: AccessibilityNodeInfo? = null,
    )

    fun classify(root: AccessibilityNodeInfo, expectedProviderDisplayName: String): List<ConversationCandidate> {
        return classifyObservedRows(observedRows(root), expectedProviderDisplayName)
    }

    fun resolveDirect(root: AccessibilityNodeInfo, expectedProviderDisplayName: String): DirectResolution {
        return resolveDirect(classify(root, expectedProviderDisplayName), expectedProviderDisplayName)
    }

    fun classifyObservedRows(rows: List<ObservedRow>, expectedProviderDisplayName: String): List<ConversationCandidate> {
        return rows.mapNotNull { row ->
            val section = normalize(row.sectionTitle)
            val evidence = listOf(row.sectionTitle, row.primaryText, row.secondaryText, row.contentDescription)
                .filter { !it.isNullOrBlank() }
                .joinToString(" ")
            val targetType = classifySection(section, row, expectedProviderDisplayName) ?: return@mapNotNull null
            val providerDisplayName = if (targetType == TargetType.DIRECT) expectedProviderDisplayName else row.primaryText
            ConversationCandidate(
                targetType = targetType,
                providerDisplayName = providerDisplayName,
                conversationTitle = row.primaryText,
                participantHints = participantHints(row),
                clickableNode = row.clickableNode,
                evidence = evidence,
                reason = reasonFor(targetType),
                targetEvidence = ConversationTargetEvidence(
                    targetType = targetType,
                    providerDisplayName = providerDisplayName,
                    normalizedIdentity = normalize(providerDisplayName),
                    rowFingerprint = rowFingerprint(row, targetType, providerDisplayName),
                    semanticRowText = evidence,
                    structuralPath = row.sectionTitle.orEmpty(),
                    clickableCandidateEvidence = listOf(
                        row.clickableNode?.className?.toString().orEmpty(),
                        row.clickableNode?.viewIdResourceName.orEmpty(),
                    ).filter { it.isNotBlank() }.joinToString("|"),
                ),
            )
        }
    }

    fun resolveDirect(candidates: List<ConversationCandidate>, expectedProviderDisplayName: String): DirectResolution {
        val expected = normalize(expectedProviderDisplayName)
        val direct = candidates.filter {
            it.targetType == TargetType.DIRECT && normalize(it.providerDisplayName) == expected
        }
        val blocked = candidates.filter { !direct.contains(it) }
        return when (direct.size) {
            0 -> DirectResolution(Resolution.NOT_FOUND, direct, blocked)
            1 -> DirectResolution(Resolution.CANDIDATE_FOUND, direct, blocked)
            else -> DirectResolution(Resolution.AMBIGUOUS, direct, blocked)
        }
    }

    private fun classifySection(section: String, row: ObservedRow, expectedProviderDisplayName: String): TargetType? {
        return when {
            matchesAny(section, OPEN_CHAT_SECTIONS) -> TargetType.OPEN_CHAT
            matchesAny(section, CHANNEL_SECTIONS) -> TargetType.CHANNEL
            matchesAny(section, PROFILE_SECTIONS) -> null
            matchesAny(section, MESSAGE_SECTIONS) -> null
            !matchesAny(section, CHAT_SECTIONS) -> TargetType.UNKNOWN
            else -> classifyNormalChatRow(row, expectedProviderDisplayName)
        }
    }

    private fun classifyNormalChatRow(row: ObservedRow, expectedProviderDisplayName: String): TargetType {
        val normalizedEvidence = normalize(listOf(row.primaryText, row.secondaryText, row.contentDescription).joinToString(" "))
        val normalizedTitle = normalize(row.primaryText)
        val expected = normalize(expectedProviderDisplayName)
        if (hasGroupEvidence(normalizedEvidence)) return TargetType.GROUP
        if (!normalizedEvidence.contains(expected)) return TargetType.UNKNOWN

        val leadingIdentity = normalizedTitle.startsWith(expected) && hasIdentityBoundaryAfter(normalizedTitle, expected.length)
        return if (leadingIdentity) TargetType.DIRECT else TargetType.GROUP
    }

    private fun hasIdentityBoundaryAfter(value: String, endIndex: Int): Boolean {
        if (value.length == endIndex) return true
        val next = value[endIndex]
        return next.isWhitespace() || next in setOf(',', '-', ':', '(', '[', '{')
    }

    private fun observedRows(root: AccessibilityNodeInfo): List<ObservedRow> {
        val flattened = mutableListOf<AccessibilityNodeInfo>()
        flatten(root, flattened)
        val rows = mutableListOf<ObservedRow>()
        var currentSection: String? = null
        for (node in flattened) {
            val text = node.text?.toString()?.trim().orEmpty()
            val description = node.contentDescription?.toString()?.trim().orEmpty()
            val visible = text.ifBlank { description }
            if (isSectionTitle(visible)) {
                currentSection = visible
                continue
            }
            if (visible.isBlank()) continue
            val clickable = firstClickableSelfOrAncestor(node)
            if (clickable != null) {
                rows.add(ObservedRow(currentSection, text.ifBlank { description }, "", description, clickable))
            }
        }
        return rows
    }

    private fun flatten(node: AccessibilityNodeInfo, out: MutableList<AccessibilityNodeInfo>) {
        out.add(node)
        for (i in 0 until node.childCount) node.getChild(i)?.let { flatten(it, out) }
    }

    private fun firstClickableSelfOrAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current: AccessibilityNodeInfo? = node
        while (current != null) {
            if (current.isClickable) return current
            current = current.parent
        }
        return null
    }

    private fun participantHints(row: ObservedRow): List<String> {
        return listOf(row.primaryText, row.secondaryText, row.contentDescription)
            .flatMap { it.split(",", "-", "/", "\u00B7") }
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
    }

    private fun hasGroupEvidence(normalizedEvidence: String): Boolean {
        return GROUP_PATTERNS.any { it.containsMatchIn(normalizedEvidence) }
    }

    private fun reasonFor(targetType: TargetType): String {
        return when (targetType) {
            TargetType.DIRECT -> "NORMAL_CHATROOM_LEADING_DIRECT_IDENTITY"
            TargetType.GROUP -> "NORMAL_CHATROOM_GROUP_OR_PREFIXED_IDENTITY"
            TargetType.OPEN_CHAT -> "OPEN_CHAT_SECTION"
            TargetType.CHANNEL -> "CHANNEL_SECTION"
            TargetType.UNKNOWN -> "AMBIGUOUS_SECTION_OR_STRUCTURE"
        }
    }

    private fun normalize(value: String?): String {
        return normalizeIdentity(value)
    }

    private fun rowFingerprint(row: ObservedRow, targetType: TargetType, providerDisplayName: String): String {
        return listOf(row.sectionTitle.orEmpty(), targetType.name, normalize(providerDisplayName)).joinToString("|")
    }

    private fun isSectionTitle(value: String): Boolean {
        val normalized = normalize(value)
        return ALL_SECTION_TITLES.any { normalized == normalize(it) }
    }

    private fun matchesAny(value: String, candidates: Set<String>): Boolean {
        return candidates.any { value.contains(normalize(it)) }
    }

    companion object {
        private val CHAT_SECTIONS = setOf(
            "\uCC44\uD305\uBC29",
            "1:1 \uCC44\uD305",
        )
        private val OPEN_CHAT_SECTIONS = setOf("\uC624\uD508\uCC44\uD305")
        private val CHANNEL_SECTIONS = setOf("\uCC44\uB110")
        private val PROFILE_SECTIONS = setOf(
            "\uCE5C\uAD6C",
            "\uD504\uB85C\uD544",
            "\uC0AC\uB78C",
            "\uCE5C\uAD6C\uCD94\uCC9C",
        )
        private val MESSAGE_SECTIONS = setOf("\uBA54\uC2DC\uC9C0", "\uB300\uD654\uB0B4\uC6A9")
        private val ALL_SECTION_TITLES =
            CHAT_SECTIONS + OPEN_CHAT_SECTIONS + CHANNEL_SECTIONS + PROFILE_SECTIONS + MESSAGE_SECTIONS + setOf("\uC804\uCCB4")

        private val GROUP_PATTERNS = listOf(
            Regex("\\b\\d+\\s*\uBA85\\b"),
            Regex("\\b\\d+\\b"),
            Regex("\uADF8\uB8F9"),
            Regex("\uBA64\uBC84"),
            Regex("\uBAA8\uC784\uBC29"),
            Regex("\uC54C\uB9BC\uAEBC\uC9D0"),
            Regex("member"),
            Regex("group"),
        )

        fun normalizeIdentity(value: String?): String {
            return Normalizer.normalize(value.orEmpty(), Normalizer.Form.NFC)
                .trim()
                .replace(Regex("\\s+"), " ")
                .lowercase()
        }
    }
}
