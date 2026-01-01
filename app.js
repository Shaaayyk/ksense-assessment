// url logic for api
const baseUrl = 'https://assessment.ksensetech.com/api';
const patientEndpoint = '/patients';
const submitEndpoint = '/submit-assessment';
// params are optional
const params = '?limit=20'
const patientUrl = baseUrl + patientEndpoint + params;
const submitUrl = baseUrl + submitEndpoint
// headers are required
const headers = { headers: { "x-api-key": process.env.DEMO_MED_API_KEY } };

// fetch request - get
async function fetchPatientsAttempt(url, options = {}, maxRetries = 5) {
  async function fetchAttempt(retriesLeft) {
    try {
      // fetch for patients
      const response = await fetch(url, options);
      console.log(response.status)
      // check for 429 error
      if (response.status === 429) {
        // throw error if too many retries have happened
        if (retriesLeft === 0) throw new Error('Max retries exceeded on rate limit');
        // see how long the wait time is in error object
        const errorJson = await response.json();
        // set to variable with return value or 9s (which was the number I saw the first time trying this)
        const retryAfterSeconds = errorJson.retry_after || 9;
        // convert seconds to ms
        const waitInMs = retryAfterSeconds * 1000;
        console.log(`waiting to retry the request, wait time is ${retryAfterSeconds} seconds`)
        // sleep for the amount of time requested
        await sleep(waitInMs);
        // recursively call fetchAttempt until successful response or maxRetries happens first
        return fetchAttempt(retriesLeft - 1)
      }
      // check for 500 or 503 errors (also encountered 502 error)
      if (response.status === 500 || response.status === 502 || response.status === 503) {
        // throw error if too many retries have happened
        if (retriesLeft === 0) throw new Error('Max retries exceeded on rate limit');
        // recursively call fetchAttempt until successful response or maxRetries happens first
        return fetchAttempt(retriesLeft)
      }

      // return response in json format
      const responseJson = await response.json();
      return responseJson;

    } catch (error) {
      // log the error if unexpected
      console.log(error)
      throw error;
    }
  };
  // call fetchAttempt for the first time
  return fetchAttempt(maxRetries);
};

// helper function - sleep
// return a new promise so await will work and wait for ms
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
};

// get all patients
// pagination - page and limit 
async function fetchAllPatients(url, currentPatients = [], pageNumber = 1) {
  // call fetchPatientsAttempt with current page number
  const response = await fetchPatientsAttempt(`${url}&page=${pageNumber}`, headers);
  console.log('response returned from fetchattempt')
  console.log(response)
  // found out through testing that sometimes response.data doesn't appear and response.patients is there instead
  const responseArray = response.data || response.patients
  // combind the response's patients and the allPatients array together 
  const allPatients = [...currentPatients, ...responseArray];
  // if there is no response.pagination then there is a response.current_page
  if (!response.pagination) {
    if (response.current_page === 3) return allPatients;
    // recursively call function again to fetch the next page
    return fetchAllPatients(url, allPatients, pageNumber + 1)
  }
  // if there is response.pagination then check for hasNext
  if (response.pagination) {
    if (!response.pagination.hasNext) return allPatients;
    // recursively call function again to fetch the next page
    return fetchAllPatients(url, allPatients, pageNumber + 1)
  }
};


// used to keep track of patient ids with invalid data
let invalidData = {};

// risk scoring - blood pressure, temperature, age
// inconsistent data - 0 points

// blood pressure - <120/<80 (both) 0 points, 120-129/<80 (both) 1 point, 130-139/80-89 (either) 2 points, >=140/>=90 (either) 3 points
// blood pressure missing/invalid - missing either number/ or /number, non-numeric values, null/undefined/empty string
function parseBloodPressure(patient, bpString) {
  // check to see if undefined, Null, and empty value
  if (typeof bpString !== 'string' || bpString === '') {
    invalidData = { ...invalidData, [patient.patient_id]: patient.patient_id };
    return 0;
  }
  // check to see if invalid format
  if (bpString === 'INVALID_BP_FORMAT' || bpString === 'N/A') {
    invalidData = { ...invalidData, [patient.patient_id]: patient.patient_id };
    return 0;
  }
  // split string into systolic and diastolic values
  const bpArray = bpString.split('/');
  // check to see if there is only one value when there should be two
  if (bpArray.length !== 2) {
    invalidData = { ...invalidData, [patient.patient_id]: patient.patient_id };
    return 0;
  }
  const [systolic, diastolic] = bpArray.map(Number)
  // check for NaN or 0
  if (isNaN(systolic) || isNaN(diastolic) || systolic === 0 || diastolic === 0) {
    invalidData = { ...invalidData, [patient.patient_id]: patient.patient_id };
    return 0;
  }
  // return points based on instructions
  if (systolic >= 140 || diastolic >= 90) return 3;
  if (systolic >= 130 || diastolic >= 80) return 2;
  if (systolic >= 120 && diastolic < 80) return 1;
  if (systolic < 120 && diastolic < 80) return 0;
  return 0;
};

// temperature - <=99.5 0 points, 99.6-100.9 1 point, >=101 2 points
// temperature missing/invalid - non-numeric values, null/undefined/empty string
function parseTemperature(patient, temp) {
  // check to see if anything but a number or NaN
  // this also handles the invalid string cases like "TEMP_ERROR", "invalid"
  if (typeof temp !== 'number' || isNaN(temp)) {
    invalidData = { ...invalidData, [patient.patient_id]: patient.patient_id };
    return 0;
  }
  // return points based on instructions
  if (temp >= 101) return 2;
  if (temp >= 99.6) return 1;
  if (temp <= 99.5) return 0;
  return 0;
};

// age - <40 0 points, 40-65 1 point, >65 2 points
// age missing/invalid - null/undefined/empty string, non-numeric values
function parseAge(patient, age) {
  // check to see if undefined, Null, and empty value
  if (age === null || age === undefined || age === '') {
    invalidData = { ...invalidData, [patient.patient_id]: patient.patient_id };
    return 0;
  }
  // check to see if is a number or string that can be parsed into a number
  const ageNum = typeof age === 'string' ? parseInt(age, 10) : age;
  // check for NaN
  if (isNaN(ageNum)) {
    invalidData = { ...invalidData, [patient.patient_id]: patient.patient_id };
    return 0;
  }
  // return points based on instructions
  if (ageNum > 65) return 2;
  if (ageNum >= 40) return 1;
  if (ageNum < 40) return 0;
  return 0
};

// total risk score - bp score + temp score + age score
function totalRiskScore(patient) {
  const bpScore = parseBloodPressure(patient, patient.blood_pressure);
  const tempScore = parseTemperature(patient, patient.temperature);
  const ageScore = parseAge(patient, patient.age);
  const totalScore = bpScore + tempScore + ageScore;
  return totalScore
};

// should be ~47 patient objects
const allPatients = await fetchAllPatients(patientUrl)

// arrays of patient ids 

// high risk - total risk score >= 4
const highRiskPatients = allPatients.filter(patient => {
  return totalRiskScore(patient) >= 4;
}).map(patient => {
  return patient.patient_id
})
console.log(highRiskPatients)

// fever - temp >=99.6
const feverPatients = allPatients.filter(patient => {
  return parseTemperature(patient, patient.temperature) >= 1;
}).map(patient => {
  return patient.patient_id
})
console.log(feverPatients)

// data quality issues - any invalid/missing data
const dataQualityIssues = Array.from(new Set(Object.values(invalidData)))
console.log(dataQualityIssues)

// fetch request - post
async function submitResults(url) {
  // make return object match what example expects
  const resultsObject = {
    high_risk_patients: highRiskPatients,
    fever_patients: feverPatients,
    data_quality_issues: dataQualityIssues
  }
  try {
    // make post request with correct headers and with body
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        "x-api-key": process.env.DEMO_MED_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(resultsObject)
    })
    // log out the json
    const responseJson = await response.json()
    console.log(responseJson)

  } catch (error) {
    console.log(error)
    throw error;
  }
}

submitResults(submitUrl)