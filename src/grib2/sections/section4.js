/**
 * Section 4 — Product Definition.
 *
 *    1–4  length
 *    5    number (=4)
 *    6–7  NV (number of coordinate values after the template)
 *    8–9  product definition template number
 *   10+   template
 *
 * We fully parse template 4.0 (analysis or forecast at a level/layer). Other
 * templates are recognized by number and we record the common fields where
 * possible; unknown fields remain as raw body slice of the template region.
 */
export function parseSection4(r, bodyLen) {
    const start = r.pos;
    const nCoordinateValues = r.uint16();
    const template = r.uint16();
    if (template === 0 || template === 1 || template === 8) {
        // Template 4.0 covers the common analysis/forecast case and shares a
        // prefix with 4.1 (ensemble) and 4.8 (statistically processed).
        const parameterCategory = r.uint8();
        const parameterNumber = r.uint8();
        const typeOfGeneratingProcess = r.uint8();
        /* backgroundProcess */ r.uint8();
        /* generatingProcessIdentifier */ r.uint8();
        /* hoursAfterDataCutoff */ r.uint16();
        /* minutesAfterDataCutoff */ r.uint8();
        const indicatorOfUnitOfTimeRange = r.uint8();
        const forecastTime = r.int32();
        const typeOfFirstFixedSurface = r.uint8();
        const scaleFactorOfFirstFixedSurface = r.int8();
        const scaledValueOfFirstFixedSurface = r.int32();
        const typeOfSecondFixedSurface = r.uint8();
        const scaleFactorOfSecondFixedSurface = r.int8();
        const scaledValueOfSecondFixedSurface = r.int32();
        r.pos = start + bodyLen;
        return {
            nCoordinateValues, template,
            parameterCategory, parameterNumber, typeOfGeneratingProcess,
            forecastTime, indicatorOfUnitOfTimeRange,
            typeOfFirstFixedSurface, scaleFactorOfFirstFixedSurface, scaledValueOfFirstFixedSurface,
            typeOfSecondFixedSurface, scaleFactorOfSecondFixedSurface, scaledValueOfSecondFixedSurface,
        };
    }
    // Unknown template — read just the (category, number) prefix that most
    // template 4.x flavors share and skip the rest. Consumers that need more
    // must add a template-specific parser here.
    const parameterCategory = r.uint8();
    const parameterNumber = r.uint8();
    r.pos = start + bodyLen;
    return {
        nCoordinateValues, template,
        parameterCategory, parameterNumber,
        typeOfGeneratingProcess: 0,
        forecastTime: 0,
        indicatorOfUnitOfTimeRange: 0,
        typeOfFirstFixedSurface: 255,
        scaleFactorOfFirstFixedSurface: 0,
        scaledValueOfFirstFixedSurface: 0,
        typeOfSecondFixedSurface: 255,
        scaleFactorOfSecondFixedSurface: 0,
        scaledValueOfSecondFixedSurface: 0,
    };
}
