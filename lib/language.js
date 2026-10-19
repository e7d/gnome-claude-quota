import {catalogTranslator, parseCatalog} from './catalog.js';
import {resetTranslator, setTranslator} from './i18n.js';

export const AUTOMATIC = '';
export const SOURCE_LANGUAGE = 'en';

function bcp47(tag) {
    return tag.replaceAll('_', '-');
}

function endonym(tag) {
    const name = new Intl.DisplayNames([bcp47(tag)], {type: 'language'}).of(bcp47(tag));
    return name.charAt(0).toLocaleUpperCase(bcp47(tag)) + name.slice(1);
}

export function languageChoices(catalogTags) {
    const collator = new Intl.Collator('und');
    return [...new Set([SOURCE_LANGUAGE, ...catalogTags])]
        .map(tag => ({tag, name: endonym(tag)}))
        .toSorted((a, b) => collator.compare(a.name, b.name));
}

export function choiceIndex(choices, language) {
    return choices.findIndex(choice => choice.tag === language) + 1;
}

export function choiceAt(choices, index) {
    return choices[index - 1]?.tag ?? AUTOMATIC;
}

function translatorFor({language, catalogs, system}) {
    if (language === SOURCE_LANGUAGE)
        return null;
    if (!catalogs.tags.includes(language))
        return system;
    return catalogTranslator(parseCatalog(catalogs.read(language)));
}

export function installLanguage(options) {
    const translator = translatorFor(options);
    if (translator)
        setTranslator(translator);
    else
        resetTranslator();
}
