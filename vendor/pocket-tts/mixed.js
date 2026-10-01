/**
 * Turning everyday mixed text into what the multiformat adapter expects.
 *
 * A port of `phonemize_mixed` from the Python package. Each part of the input
 * goes the shortest way to phonemes it can:
 *
 * - `[[ʃalˈom]]` is already unambiguous, so the brackets come off and nothing else
 *   happens to it;
 * - Hebrew carrying nikud is already unambiguous, so it is kept exactly as
 *   written and tokenized as atomic Hebrew and nikud characters;
 * - unvocalized Hebrew goes through renikud;
 * - Latin script goes through espeak.
 */
const LITERAL = /\[\[([\s\S]*?)\]\]/g;
const WORDS = /(\s+)/;
const SCRIPTS = /[֐-׿]+|[^֐-׿]+/g;
const STRESS = "ˈ";
/** A nikud mark, or the phonikud prefix boundary, makes a word unambiguous. */
function hasNikud(word) {
    for (const char of word) {
        const code = char.codePointAt(0);
        if ((code >= 0x0590 && code <= 0x05cf) || char === "|")
            return true;
    }
    return false;
}
function script(run) {
    let latin = false;
    for (const char of run) {
        const code = char.codePointAt(0);
        if (code >= 0x05d0 && code <= 0x05ff)
            return "hebrew";
        if (/\p{L}/u.test(char))
            latin = true;
    }
    return latin ? "latin" : "neutral";
}
/** Split into stretches of one script, keeping vocalized words whole. */
function runs(text) {
    const out = [];
    for (const token of text.split(WORDS)) {
        if (token === "")
            continue;
        if (/^\s+$/.test(token))
            out.push(["neutral", token]);
        else if (hasNikud(token))
            out.push(["vocalized", token]);
        // A word can hold both scripts, as in "ב-Google".
        else
            for (const run of token.match(SCRIPTS) ?? [])
                out.push([script(run), run]);
    }
    return out;
}
/** Merge neighbouring runs so each phonemizer sees whole phrases. */
function groups(text) {
    const merged = [];
    for (const [kind, run] of runs(text)) {
        const last = merged[merged.length - 1];
        if (last && (kind === "neutral" || last[0] === kind))
            last[1].push(run);
        else if (last && last[0] === "neutral" && merged.length === 1) {
            merged[0] = [kind, [...last[1], run]];
        }
        else
            merged.push([kind, [run]]);
    }
    return merged.map(([kind, parts]) => [kind, parts.join("")]);
}
/**
 * Clean up the seams between two phonemizers.
 *
 * A one-letter Hebrew prefix such as the `ב` of `ב-Google` reaches renikud with
 * no word around it, and can come back as a bare stress mark that then collides
 * with the stress of the word after it.
 */
function tidy(ipa) {
    return ipa
        .replace(new RegExp(`${STRESS}{2,}`, "g"), STRESS)
        .replace(new RegExp(`${STRESS}(?=[\\s,.!?;:]|$)`, "g"), "");
}
async function convert(text, phonemizers) {
    const pieces = [];
    for (const [kind, group] of groups(text)) {
        if (kind !== "hebrew" && kind !== "latin") {
            pieces.push(group); // already vocalized, or punctuation
            continue;
        }
        // Both backends strip, which would weld words together across a group
        // boundary, so the surrounding space is put back by hand.
        const lead = group.slice(0, group.length - group.trimStart().length);
        const trail = group.slice(group.trimEnd().length);
        const core = group.trim();
        const spoken = kind === "hebrew" ? await phonemizers.hebrew(core) : await phonemizers.latin(core);
        pieces.push(lead + spoken + trail);
    }
    return pieces.join("");
}
export async function phonemizeMixed(text, phonemizers) {
    const out = [];
    let at = 0;
    LITERAL.lastIndex = 0;
    for (let match = LITERAL.exec(text); match; match = LITERAL.exec(text)) {
        out.push(await convert(text.slice(at, match.index), phonemizers));
        out.push(match[1]);
        at = match.index + match[0].length;
    }
    out.push(await convert(text.slice(at), phonemizers));
    return tidy(out.join("").trim());
}
