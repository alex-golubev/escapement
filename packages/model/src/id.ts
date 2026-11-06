import { Brand, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

/** What a project keys an object by, made by the client that creates the object, without asking anyone. */
export type Id = Brand.Branded<string, 'Id'>

/** Any key a document holds is an ID; new ones are `newId`'s. */
export const Id = Brand.nominal<Id>()

/** An ID as a document or another client holds it, read as anything: a string that isn't empty. */
export const storedId = Schema.NonEmptyString.pipe(Schema.fromBrand('Id', Id))

/** 96 random bits as 16 characters of base64url: short in every note, and no two clients make the same, even offline. */
export const newId = (): Id => Id(Base64Url.encode(crypto.getRandomValues(new Uint8Array(12))))
