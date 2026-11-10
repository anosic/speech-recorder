/**
 * Model presets behind the `anosicSpeech.model` setting. Each preset fixes a Hugging Face model id and weight variant
 * that are known to exist together, so the dropdown can't produce a broken combination. `custom` uses the
 * `anosicSpeech.custom*` settings instead.
 *
 * The enum, labels and descriptions in package.json (`contributes.configuration`) mirror this table; keep the two in
 * step. Sizes are the q8 download (encoder + merged decoder), as listed on Hugging Face.
 */
export const MODEL_PRESETS = {
	'tiny': { model: 'Xenova/whisper-tiny', dtype: 'q8', downloadMb: 41 },
	'base': { model: 'Xenova/whisper-base', dtype: 'q8', downloadMb: 77 },
	// onnx-community rather than Xenova: this was the extension's default before presets, so existing caches stay valid.
	'small': { model: 'onnx-community/whisper-small', dtype: 'q8', downloadMb: 249 },
	'large-v3-turbo': { model: 'onnx-community/whisper-large-v3-turbo', dtype: 'q8', downloadMb: 1085 },
} as const;

export type ModelPreset = keyof typeof MODEL_PRESETS;
export const DEFAULT_PRESET: ModelPreset = 'small';

export interface ModelChoice {
	/** Preset name, or `custom`. */
	preset: string;
	model: string;
	dtype: string;
	revision: string;
}

/**
 * Resolve the settings to a model. A `model` value that is neither a preset nor `custom` is treated as a custom model
 * id: before presets existed, `anosicSpeech.model` held the Hugging Face id itself.
 */
export function resolveModel(get: <T>(key: string, fallback: T) => T): ModelChoice {
	const preset = get<string>('model', DEFAULT_PRESET);
	if (preset in MODEL_PRESETS) {
		const p = MODEL_PRESETS[preset as ModelPreset];
		return { preset, model: p.model, dtype: p.dtype, revision: 'main' };
	}
	return {
		preset: 'custom',
		model: preset === 'custom' ? get<string>('customModel', '') || MODEL_PRESETS[DEFAULT_PRESET].model : preset,
		dtype: get<string>('customDtype', 'q8'),
		revision: get<string>('customRevision', '') || 'main',
	};
}
