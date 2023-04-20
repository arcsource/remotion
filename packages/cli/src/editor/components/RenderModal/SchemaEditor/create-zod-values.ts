import {Internals} from 'remotion';
import type {z} from 'zod';
import type {ZodType} from '../../get-zod-if-possible';

export const createZodValues = (
	schema: Zod.ZodTypeAny,
	zodRuntime: ZodType
): unknown => {
	if (!schema) {
		throw new Error('Invalid zod schema');
	}

	const def = schema._def;
	const typeName = def.typeName as z.ZodFirstPartyTypeKind;

	switch (typeName) {
		case zodRuntime.ZodFirstPartyTypeKind.ZodString:
			return '';
		case zodRuntime.ZodFirstPartyTypeKind.ZodNumber:
			return 0;
		case zodRuntime.ZodFirstPartyTypeKind.ZodBigInt:
			return BigInt(0);
		case zodRuntime.ZodFirstPartyTypeKind.ZodBoolean:
			return false;
		case zodRuntime.ZodFirstPartyTypeKind.ZodNaN:
			return NaN;
		case zodRuntime.ZodFirstPartyTypeKind.ZodDate:
			return new Date();
		case zodRuntime.ZodFirstPartyTypeKind.ZodSymbol:
			return Symbol('remotion');
		case zodRuntime.ZodFirstPartyTypeKind.ZodUndefined:
			return undefined;
		case zodRuntime.ZodFirstPartyTypeKind.ZodNull:
			return null;
		case zodRuntime.ZodFirstPartyTypeKind.ZodAny:
			throw new Error('Cannot create a value for type z.any()');
		case zodRuntime.ZodFirstPartyTypeKind.ZodUnknown:
			throw new Error('Cannot create a value for type z.unknown()');
		case zodRuntime.ZodFirstPartyTypeKind.ZodNever:
			throw new Error('Cannot create a value for type z.never()');
		case zodRuntime.ZodFirstPartyTypeKind.ZodVoid:
			return undefined;
		case zodRuntime.ZodFirstPartyTypeKind.ZodObject: {
			const shape = (def as z.ZodObjectDef).shape();
			const keys = Object.keys(shape);
			const returnValue = keys.reduce((existing, key) => {
				existing[key] = createZodValues(shape[key], zodRuntime);
				return existing;
			}, {} as Record<string, unknown>);
			return returnValue;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodArray: {
			return [createZodValues((def as z.ZodArrayDef).type, zodRuntime)];
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodUnion: {
			const firstOptions = (def as z.ZodUnionDef).options[0];
			return firstOptions
				? createZodValues(firstOptions, zodRuntime)
				: undefined;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
			const options = (def as z.ZodDiscriminatedUnionDef<string>).options[0];
			return createZodValues(options, zodRuntime);
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodLiteral: {
			return (def as z.ZodLiteralDef).value;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodEffects: {
			if (schema._def.description === Internals.REMOTION_COLOR_BRAND) {
				return '#ffffff';
			}

			return createZodValues((def as z.ZodEffectsDef).schema, zodRuntime);
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodIntersection: {
			const {left, right} = def as z.ZodIntersectionDef;
			const leftValue = createZodValues(left, zodRuntime);
			if (typeof leftValue !== 'object') {
				throw new Error(
					'Cannot create value for type z.intersection: Left side is not an object'
				);
			}

			const rightValue = createZodValues(right, zodRuntime);

			if (typeof rightValue !== 'object') {
				throw new Error(
					'Cannot create value for type z.intersection: Right side is not an object'
				);
			}

			return {...leftValue, ...rightValue};
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodTuple: {
			const items = (def as z.ZodTupleDef).items.map((item) =>
				createZodValues(item, zodRuntime)
			);
			return items;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodRecord: {
			const values = createZodValues(
				(def as z.ZodRecordDef).valueType,
				zodRuntime
			);
			return {key: values};
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodMap: {
			const defType = def as z.ZodMapDef;
			const values = createZodValues(defType.valueType, zodRuntime);
			const key = createZodValues(defType.keyType, zodRuntime);
			return new Map([[key, values]]);
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodLazy: {
			const defType = def as z.ZodLazyDef;
			const type = defType.getter();
			return createZodValues(type, zodRuntime);
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodSet: {
			const defType = def as z.ZodSetDef;
			const values = createZodValues(defType.valueType, zodRuntime);
			return new Set([values]);
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodFunction: {
			throw new Error('Cannot create a value for type function');
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodEnum: {
			const {values} = def as z.ZodEnumDef;
			return values[0];
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodNativeEnum: {
			return 0;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodOptional: {
			const defType = def as z.ZodOptionalDef;
			const value = createZodValues(defType.innerType, zodRuntime);
			return value;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodNullable: {
			const defType = def as z.ZodNullableDef;
			const value = createZodValues(defType.innerType, zodRuntime);
			return value;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodDefault: {
			const defType = def as z.ZodDefaultDef;
			return defType.defaultValue();
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodCatch: {
			const defType = def as z.ZodCatchDef;
			const value = createZodValues(defType.innerType, zodRuntime);
			return value;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodPromise: {
			const defType = def as z.ZodPromiseDef;
			const value = createZodValues(defType.type, zodRuntime);
			return Promise.resolve(value);
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodBranded: {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const defType = def as z.ZodBrandedDef<any>;
			const value = createZodValues(defType.type, zodRuntime);
			return value;
		}

		case zodRuntime.ZodFirstPartyTypeKind.ZodPipeline: {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const defType = def as z.ZodPipelineDef<any, any>;
			const value = createZodValues(defType.out, zodRuntime);
			return value;
		}

		default:
			throw new Error('Not implemented: ' + typeName);
	}
};
